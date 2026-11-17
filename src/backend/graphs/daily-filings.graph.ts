import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { scrapeFilingsForDate, type RawBseFiling, type FetchFailure } from '../services/daily-filings.service';
import { fetchPdfText } from '../utils/pdf';
import { isDailyFilingKnown, saveDailyFiling, type FilingInsights } from '../services/turso.service';
import { notifyAsync } from '../services/telegram.service';
import { buildDigest } from '../services/filings-digest';
import { chatModel, withLlmSlot } from '../services/llm';
import { FilingImportanceSchema, FilingInsightsSchema, FILING_CATEGORIES } from '../schemas';
import { updateScrapeStage } from '../routes/daily-filings.route';

// ── Models ────────────────────────────────────────────────────────────────────

function classifyModel() {
  // cheap tier — it only reads titles
  return chatModel('fast', { temperature: 0, maxTokens: 150 }).withStructuredOutput(FilingImportanceSchema);
}

function insightModel() {
  return chatModel('main', { temperature: 0.1, maxTokens: 800 }).withStructuredOutput(FilingInsightsSchema);
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
  totalScraped:  Annotation<number>,          // exchange results before dedup
  companies:     Annotation<number>,          // companies attempted
  failures:      Annotation<FetchFailure[]>,  // companies where NSE and BSE both failed
  rawFilings:    Annotation<RawBseFiling[]>,  // new filings after dedup
  classified:    Annotation<ClassifiedFiling[]>,
  unclassified:  Annotation<RawBseFiling[]>,  // classifier call failed; not saved, so a re-run retries them
  processed:     Annotation<ProcessedFiling[]>,
  savedCount:    Annotation<number>,
});

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function scrapeNode(state: typeof DailyFilingsAnnotation.State) {
  updateScrapeStage('scraping', `NSE/BSE filings for ${state.targetDate}`);
  const date = state.targetDate ? new Date(state.targetDate) : undefined;
  const { filings, failures, companies } = await scrapeFilingsForDate(date);
  const totalScraped = filings.length;

  updateScrapeStage('deduping', `${totalScraped} raw filings, ${failures.length}/${companies} companies failed`);
  const newFilings: RawBseFiling[] = [];
  const seen = new Set<string>();
  for (const f of filings) {
    if (seen.has(f.pdfUrl)) continue;
    seen.add(f.pdfUrl);
    if (!(await isDailyFilingKnown(f.pdfUrl))) newFilings.push(f);
  }
  updateScrapeStage('scraped', `total=${totalScraped} new=${newFilings.length} (${totalScraped - newFilings.length} already seen)`);
  return { rawFilings: newFilings, totalScraped, failures, companies };
}

async function classifyNode(state: typeof DailyFilingsAnnotation.State) {
  updateScrapeStage('classifying', `${state.rawFilings.length} new filings via Groq`);
  if (!state.rawFilings.length) return { classified: [] as ClassifiedFiling[], unclassified: [] as RawBseFiling[] };

  const classified: ClassifiedFiling[] = [];
  const unclassified: RawBseFiling[] = [];
  const model = classifyModel();

  for (const filing of state.rawFilings) {
    try {
      const result = await withLlmSlot(() => model.invoke([
        new SystemMessage(
          `You are a financial analyst assistant. Classify the importance of Indian stock exchange (NSE/BSE) filings.
Score 1–5 where:
5 = Financial results, major acquisition, CEO/MD change, regulatory action, profit warning
4 = Investor presentation WITH actual guidance/numbers, significant board decision, dividend announcement
3 = Material press release (new contract, partnership, product launch), ESOP/allotment with real numbers, minor operational update, routine board meeting outcome
2 = Administrative filing, change of registered office, meeting/call SCHEDULE intimation with no content yet, statutory compliance
1 = Trivial/routine regulatory filing with no investor relevance (boilerplate Reg 30 disclosures, generic compliance certificates)

Score based on likely investor relevance, not just how generic the exchange title sounds — many genuinely material filings (e.g. a large new contract) get filed under bland regulatory titles.

Also classify into: earnings | board | investor_meet | press_release | management_change | acquisition | regulatory | other`
        ),
        new HumanMessage(
          `Company: ${filing.ticker}\nExchange category: ${filing.bseCategory}\nTitle: ${filing.title}\n\nClassify this filing.`
        ),
      ]));
      classified.push({
        ...filing,
        isImportant: result.score >= IMPORTANCE_THRESHOLD,
        importance:  result.score,
        filingCat:   result.filingCategory as typeof FILING_CATEGORIES[number],
        reason:      result.reason,
      });
    } catch (err) {
      // Used to be saved as importance 1, which buried every filing whenever Groq
      // was down (e.g. after the model shutdown) and dedup meant it never came back.
      console.error(`[classify] ${filing.ticker} failed:`, String(err).slice(0, 200));
      unclassified.push(filing);
    }
  }

  const important = classified.filter(c => c.isImportant).length;
  updateScrapeStage('classified', `${classified.length} filings — ${important} important, ${unclassified.length} failed`);
  return { classified, unclassified };
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
    } catch {
      // BSE AttachHis may 404 for same-day filings — try AttachLive (no-op for NSE URLs)
      const livePdfUrl = filing.pdfUrl.replace('/AttachHis/', '/AttachLive/');
      try {
        if (livePdfUrl === filing.pdfUrl) throw new Error('no alternate URL');
        textContent = await fetchPdfText(livePdfUrl);
        pdfOk++;
      } catch {
        pdfFail++;
        console.log(`[graph:process] PDF failed — proceeding without text`);
        textContent = '';
      }
    }

    if (textContent.length > 200) {
      try {
        const result = await withLlmSlot(() => model.invoke([
          new SystemMessage(
            `You are a financial analyst. Extract key insights from this stock exchange filing for ${filing.ticker}.
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
        ]));
        insights = {
          summary:    result.summary,
          keyPoints:  result.keyPoints,
          sentiment:  result.sentiment,
          actionable: result.actionable,
          watchFor:   result.watchFor,
        };
        sentiment = result.sentiment;
      } catch (err) {
        console.error(`[insights] ${filing.ticker} failed:`, String(err).slice(0, 200));
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
        filedAt:     f.filedAt,
      });
      savedCount++;
    } catch (err) {
      console.error(`[save] ${f.ticker} failed:`, String(err).slice(0, 200));
    }
  }
  updateScrapeStage('saved', `${savedCount} filings written to DB`);
  return { savedCount };
}

// ── Telegram digest ───────────────────────────────────────────────────────────

async function notifyNode(state: typeof DailyFilingsAnnotation.State) {
  const parts = buildDigest({
    targetDate:   state.targetDate,
    companies:    state.companies,
    totalScraped: state.totalScraped,
    failures:     state.failures ?? [],
    newCount:     state.rawFilings.length,
    processed:    state.processed ?? [],
    unclassified: state.unclassified ?? [],
  });
  for (const part of parts) {
    try {
      await notifyAsync(part);
    } catch (err) {
      console.error('[daily-filings] Telegram send failed:', String(err));
    }
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

let inFlight: Promise<{ saved: number; important: number }> | null = null;

/**
 * Single-flight: QStash and node-cron used to fire at the same minute, so two
 * scrapes ran together and the second one posted a "(all already in DB)" digest
 * repeating every title. A second caller now joins the run already in progress.
 */
export function runDailyFilingsScrape(targetDate?: string): Promise<{ saved: number; important: number }> {
  if (inFlight) return inFlight;
  const date = targetDate ?? new Date().toISOString().slice(0, 10);
  inFlight = (async () => {
    const state = await dailyFilingsGraph.invoke({
      targetDate:   date,
      totalScraped: 0,
      companies:    0,
      failures:     [],
      rawFilings:   [],
      classified:   [],
      unclassified: [],
      processed:    [],
      savedCount:   0,
    });
    return {
      saved:     state.savedCount,
      important: (state.processed ?? []).filter((f: ProcessedFiling) => f.isImportant).length,
    };
  })().finally(() => { inFlight = null; });
  return inFlight;
}
