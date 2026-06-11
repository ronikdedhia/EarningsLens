import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { ChatGroq } from '@langchain/groq';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { scrapeFilingsForDate, type RawBseFiling } from '../services/daily-filings.service';
import { fetchPdfText } from '../utils/pdf';
import { isDailyFilingKnown, saveDailyFiling, type FilingInsights } from '../services/turso.service';
import { notify } from '../services/telegram.service';
import { FilingImportanceSchema, FilingInsightsSchema, FILING_CATEGORIES } from '../schemas';

// ── Models ────────────────────────────────────────────────────────────────────

function classifyModel() {
  return new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model:  'llama-3.1-8b-instant',   // cheap — just classifying titles
    temperature: 0,
    maxTokens:   150,
  }).withStructuredOutput(FilingImportanceSchema);
}

function insightModel() {
  return new ChatGroq({
    apiKey:      process.env.GROQ_API_KEY,
    model:       process.env.GROQ_MODEL ?? 'llama-3.1-70b-versatile',
    temperature: 0.1,
    maxTokens:   800,
  }).withStructuredOutput(FilingInsightsSchema);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassifiedFiling extends RawBseFiling {
  isImportant:  boolean;
  importance:   number;
  filingCat:    typeof FILING_CATEGORIES[number];
  reason:       string;
}

interface ProcessedFiling extends ClassifiedFiling {
  textContent: string;
  insights:    FilingInsights | null;
  sentiment:   string;
}

// ── State ─────────────────────────────────────────────────────────────────────

const DailyFilingsAnnotation = Annotation.Root({
  targetDate:        Annotation<string>,          // YYYY-MM-DD
  rawFilings:        Annotation<RawBseFiling[]>,
  classified:        Annotation<ClassifiedFiling[]>,
  processed:         Annotation<ProcessedFiling[]>,
  savedCount:        Annotation<number>,
});

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function scrapeNode(state: typeof DailyFilingsAnnotation.State) {
  const date = state.targetDate ? new Date(state.targetDate) : undefined;
  const rawFilings = await scrapeFilingsForDate(date);

  // Filter out filings already in DB
  const newFilings: RawBseFiling[] = [];
  for (const f of rawFilings) {
    if (!(await isDailyFilingKnown(f.pdfUrl))) newFilings.push(f);
  }
  return { rawFilings: newFilings };
}

async function classifyNode(state: typeof DailyFilingsAnnotation.State) {
  if (!state.rawFilings.length) return { classified: [] as ClassifiedFiling[] };

  const classified: ClassifiedFiling[] = [];
  const model = classifyModel();

  for (const filing of state.rawFilings) {
    try {
      const result = await model.invoke([
        new SystemMessage(
          `You are a financial analyst assistant. Classify the importance of BSE stock exchange filings.
Score 1–5 where:
5 = Financial results, major acquisition, CEO/MD change, regulatory action, profit warning
4 = Investor presentation with guidance, significant board decision, dividend announcement
3 = Minor operational update, routine board meeting outcome
2 = Administrative filing, change of registered office, statutory compliance
1 = Trivial/routine regulatory filing with no investor relevance

Also classify into: earnings | board | investor_meet | press_release | management_change | acquisition | regulatory | other`
        ),
        new HumanMessage(
          `Company: ${filing.ticker}\nBSE Category: ${filing.bseCategory}\nTitle: ${filing.title}\n\nClassify this filing.`
        ),
      ]);
      classified.push({
        ...filing,
        isImportant: result.isImportant,
        importance:  result.score,
        filingCat:   result.filingCategory as typeof FILING_CATEGORIES[number],
        reason:      result.reason,
      });
    } catch {
      // default to unimportant on error
      classified.push({ ...filing, isImportant: false, importance: 1, filingCat: 'other', reason: '' });
    }
  }

  return { classified };
}

async function downloadAndInsightNode(state: typeof DailyFilingsAnnotation.State) {
  const processed: ProcessedFiling[] = [];
  const model = insightModel();

  for (const filing of state.classified) {
    // Always record the filing; only download text for important ones
    if (!filing.isImportant) {
      processed.push({ ...filing, textContent: '', insights: null, sentiment: 'neutral' });
      continue;
    }

    let textContent = '';
    let insights: FilingInsights | null = null;
    let sentiment = 'neutral';

    try {
      textContent = await fetchPdfText(filing.pdfUrl);
    } catch {
      // AttachHis may 404 for same-day filings — try AttachLive
      try {
        const livePdfUrl = filing.pdfUrl.replace('/AttachHis/', '/AttachLive/');
        textContent = await fetchPdfText(livePdfUrl);
      } catch {
        textContent = '';
      }
    }

    if (textContent.length > 200) {
      try {
        const result = await model.invoke([
          new SystemMessage(
            `You are a financial analyst. Extract key insights from this BSE filing for ${filing.ticker}.
Filing category: ${filing.bseCategory}
Filing title: ${filing.title}

Provide:
- summary: 1–2 sentence summary of what this filing says
- keyPoints: up to 5 bullet-point takeaways (numbers, dates, decisions)
- sentiment: overall sentiment for the stock (positive/negative/neutral)
- actionable: true if this warrants immediate attention from an investor
- watchFor: what to watch in the next earnings call or filing related to this`
          ),
          new HumanMessage(textContent.slice(0, 8000)),
        ]);
        insights = {
          summary:    result.summary,
          keyPoints:  result.keyPoints,
          sentiment:  result.sentiment,
          actionable: result.actionable,
          watchFor:   result.watchFor,
        };
        sentiment = result.sentiment;
      } catch {
        insights = null;
      }
    }

    processed.push({ ...filing, textContent, insights, sentiment });
  }

  return { processed };
}

async function saveNode(state: typeof DailyFilingsAnnotation.State) {
  let savedCount = 0;
  for (const f of state.processed) {
    try {
      await saveDailyFiling({
        ticker:      f.ticker,
        filingDate:  f.filingDate,
        category:    f.bseCategory,
        title:       f.title,
        pdfUrl:      f.pdfUrl,
        textContent: f.textContent,
        importance:  f.importance,
        isImportant: f.isImportant,
        filingCat:   f.filingCat,
        insights:    f.insights,
        sentiment:   f.sentiment,
      });
      savedCount++;
    } catch {
      // non-fatal per filing
    }
  }
  return { savedCount };
}

async function notifyNode(state: typeof DailyFilingsAnnotation.State) {
  const important = state.processed.filter(f => f.isImportant);
  if (!important.length) {
    notify(`📋 *EarningsLens Daily Filings* — ${state.targetDate}\nNo important filings found today.`);
    return {};
  }

  const lines = important.slice(0, 10).map(f => {
    const emoji = f.importance >= 5 ? '🔴' : f.importance >= 4 ? '🟡' : '🟢';
    const insight = f.insights?.summary ? `\n   _${f.insights.summary.slice(0, 100)}_` : '';
    return `${emoji} *${f.ticker}* — ${f.title.slice(0, 80)}${insight}`;
  });

  notify(
    `📋 *EarningsLens Daily Filings* — ${state.targetDate}\n` +
    `${important.length} important filing${important.length !== 1 ? 's' : ''} found\n\n` +
    lines.join('\n')
  );
  return {};
}

// ── Graph ─────────────────────────────────────────────────────────────────────

const workflow = new StateGraph(DailyFilingsAnnotation)
  .addNode('scrape',    scrapeNode)
  .addNode('classify',  classifyNode)
  .addNode('process',   downloadAndInsightNode)
  .addNode('save',      saveNode)
  .addNode('notify',    notifyNode)
  .addEdge(START,       'scrape')
  .addConditionalEdges('scrape',
    state => state.rawFilings.length ? 'classify' : 'notify',
    { classify: 'classify', notify: 'notify' }
  )
  .addEdge('classify',  'process')
  .addEdge('process',   'save')
  .addEdge('save',      'notify')
  .addEdge('notify',    END);

export const dailyFilingsGraph = workflow.compile();

export async function runDailyFilingsScrape(targetDate?: string): Promise<{ saved: number; important: number }> {
  const date = targetDate ?? new Date().toISOString().slice(0, 10);
  const state = await dailyFilingsGraph.invoke({
    targetDate:  date,
    rawFilings:  [],
    classified:  [],
    processed:   [],
    savedCount:  0,
  });
  return {
    saved:     state.savedCount,
    important: state.processed.filter((f: ProcessedFiling) => f.isImportant).length,
  };
}
