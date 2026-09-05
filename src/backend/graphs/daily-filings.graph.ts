import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { ChatGroq } from '@langchain/groq';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { scrapeFilingsForDate, type RawBseFiling } from '../services/daily-filings.service';
import { fetchPdfText } from '../utils/pdf';
import { isDailyFilingKnown, saveDailyFiling, type FilingInsights } from '../services/turso.service';
import { notify } from '../services/telegram.service';
import { FilingImportanceSchema, FilingInsightsSchema, FILING_CATEGORIES } from '../schemas';
import { updateScrapeStage } from '../routes/daily-filings.route';

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

// Filings scoring at/above this are worth a PDF fetch + LLM summary.
// Model's own isImportant boolean is ignored — derived from score for a single, tunable cutoff.
const IMPORTANCE_THRESHOLD = 3;

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
  targetDate:    Annotation<string>,          // YYYY-MM-DD
  totalScraped:  Annotation<number>,          // BSE results before dedup
  allScraped:    Annotation<RawBseFiling[]>,  // full list before dedup (for notify)
  rawFilings:    Annotation<RawBseFiling[]>,  // new filings after dedup
  classified:    Annotation<ClassifiedFiling[]>,
  processed:     Annotation<ProcessedFiling[]>,
  savedCount:    Annotation<number>,
});

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function scrapeNode(state: typeof DailyFilingsAnnotation.State) {
  updateScrapeStage('scraping', `BSE filings for ${state.targetDate}`);
  const date = state.targetDate ? new Date(state.targetDate) : undefined;
  const allFilings = await scrapeFilingsForDate(date);
  const totalScraped = allFilings.length;

  updateScrapeStage('deduping', `${totalScraped} raw filings from BSE`);
  const newFilings: RawBseFiling[] = [];
  for (const f of allFilings) {
    if (!(await isDailyFilingKnown(f.pdfUrl))) newFilings.push(f);
  }
  updateScrapeStage('scraped', `total=${totalScraped} new=${newFilings.length} (${totalScraped - newFilings.length} already seen)`);
  return { rawFilings: newFilings, allScraped: allFilings, totalScraped };
}

async function classifyNode(state: typeof DailyFilingsAnnotation.State) {
  updateScrapeStage('classifying', `${state.rawFilings.length} new filings via Groq`);
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
4 = Investor presentation WITH actual guidance/numbers, significant board decision, dividend announcement
3 = Material press release (new contract, partnership, product launch), ESOP/allotment with real numbers, minor operational update, routine board meeting outcome
2 = Administrative filing, change of registered office, meeting/call SCHEDULE intimation with no content yet, statutory compliance
1 = Trivial/routine regulatory filing with no investor relevance (boilerplate Reg 30 disclosures, generic compliance certificates)

Score based on likely investor relevance, not just how generic the BSE title sounds — many genuinely material filings (e.g. a large new contract) get filed under bland regulatory titles.

Also classify into: earnings | board | investor_meet | press_release | management_change | acquisition | regulatory | other`
        ),
        new HumanMessage(
          `Company: ${filing.ticker}\nBSE Category: ${filing.bseCategory}\nTitle: ${filing.title}\n\nClassify this filing.`
        ),
      ]);
      classified.push({
        ...filing,
        isImportant: result.score >= IMPORTANCE_THRESHOLD,
        importance:  result.score,
        filingCat:   result.filingCategory as typeof FILING_CATEGORIES[number],
        reason:      result.reason,
      });
    } catch {
      // default to unimportant on error
      classified.push({ ...filing, isImportant: false, importance: 1, filingCat: 'other', reason: '' });
    }
  }

  const important = classified.filter(c => c.isImportant).length;
  updateScrapeStage('classified', `${classified.length} filings — ${important} important`);
  return { classified };
}

async function downloadAndInsightNode(state: typeof DailyFilingsAnnotation.State) {
  const importantCount = state.classified.filter(f => f.isImportant).length;
  updateScrapeStage('downloading', `PDFs + insights for ${importantCount} important filings`);
  const processed: ProcessedFiling[] = [];
  const model = insightModel();

  let pdfOk = 0, pdfFail = 0;
  for (const filing of state.classified) {
    // Always record the filing; only download text for important ones
    if (!filing.isImportant) {
      processed.push({ ...filing, textContent: '', insights: null, sentiment: 'neutral' });
      continue;
    }

    updateScrapeStage('downloading-pdf', `${filing.ticker} — ${filing.title.slice(0, 60)}`);
    let textContent = '';
    let insights: FilingInsights | null = null;
    let sentiment = 'neutral';

    try {
      textContent = await fetchPdfText(filing.pdfUrl);
      pdfOk++;
      console.log(`[graph:process] PDF ok (${textContent.length} chars)`);
    } catch {
      // AttachHis may 404 for same-day filings — try AttachLive
      try {
        const livePdfUrl = filing.pdfUrl.replace('/AttachHis/', '/AttachLive/');
        textContent = await fetchPdfText(livePdfUrl);
        pdfOk++;
        console.log(`[graph:process] PDF ok via AttachLive (${textContent.length} chars)`);
      } catch {
        pdfFail++;
        console.log(`[graph:process] PDF failed — proceeding without text`);
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

  updateScrapeStage('processed', `${processed.length} filings — pdf_ok=${pdfOk} pdf_fail=${pdfFail}`);
  return { processed };
}

async function saveNode(state: typeof DailyFilingsAnnotation.State) {
  updateScrapeStage('saving', `${state.processed.length} filings to DB`);
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
  updateScrapeStage('saved', `${savedCount} filings written to DB`);
  return { savedCount };
}

function truncateTitle(title: string, max = 100): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut) + '…';
}

function groupByTicker<T extends { ticker: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    if (!map.has(item.ticker)) map.set(item.ticker, []);
    map.get(item.ticker)!.push(item);
  }
  return map;
}

async function notifyNode(state: typeof DailyFilingsAnnotation.State) {
  if (!state.rawFilings.length) {
    if (state.totalScraped === 0) {
      notify(`📋 *EarningsLens* — ${state.targetDate}\n⚠️ BSE returned 0 filings — possible API blip.`);
      return {};
    }
    // All already in DB — group by ticker, show titles
    const grouped = groupByTicker(state.allScraped ?? []);
    const sections: string[] = [];
    for (const [ticker, filings] of grouped) {
      const titles = filings.map(f => `  · ${truncateTitle(f.title)}`).join('\n');
      sections.push(`*${ticker}* (${filings.length})\n${titles}`);
    }
    const CHUNK = 8; // tickers per message
    const tickers = [...grouped.keys()];
    for (let i = 0; i < sections.length; i += CHUNK) {
      const header = i === 0
        ? `📋 *EarningsLens* — ${state.targetDate}\n${state.totalScraped} filings (all already in DB)\n\n`
        : `📋 _(continued)_\n\n`;
      notify(header + sections.slice(i, i + CHUNK).join('\n\n'));
    }
    return {};
  }

  const important = state.processed.filter(f => f.isImportant);

  if (!important.length) {
    // New filings saved but none important — group by ticker
    const grouped = groupByTicker(state.processed);
    const sections: string[] = [];
    for (const [ticker, filings] of grouped) {
      const titles = filings.map(f => `  · ${truncateTitle(f.title)}`).join('\n');
      sections.push(`*${ticker}* (${filings.length})\n${titles}`);
    }
    notify(
      `📋 *EarningsLens* — ${state.targetDate}\n` +
      `${state.processed.length} new filings saved, none flagged important\n\n` +
      sections.join('\n\n')
    );
    return {};
  }

  // Important filings — grouped by ticker, with insight summary
  const grouped = groupByTicker(important);
  const sections: string[] = [];
  for (const [ticker, filings] of grouped) {
    const lines = filings.map(f => {
      const emoji = f.importance >= 5 ? '🔴' : f.importance >= 4 ? '🟡' : '🟢';
      const summary = f.insights?.summary ? `\n    _${f.insights.summary.slice(0, 120)}_` : '';
      return `  ${emoji} ${truncateTitle(f.title)}${summary}`;
    });
    sections.push(`*${ticker}* (${filings.length})\n${lines.join('\n')}`);
  }

  const CHUNK = 6;
  for (let i = 0; i < sections.length; i += CHUNK) {
    const header = i === 0
      ? `📋 *EarningsLens* — ${state.targetDate}\n${important.length} important of ${state.rawFilings.length} new filings\n\n`
      : `📋 _(continued)_\n\n`;
    notify(header + sections.slice(i, i + CHUNK).join('\n\n'));
  }
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
    targetDate:   date,
    totalScraped: 0,
    allScraped:   [],
    rawFilings:   [],
    classified:   [],
    processed:    [],
    savedCount:   0,
  });
  return {
    saved:     state.savedCount,
    important: state.processed.filter((f: ProcessedFiling) => f.isImportant).length,
  };
}
