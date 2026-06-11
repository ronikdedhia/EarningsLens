import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { searchChunks } from '../services/qdrant.service';
import { embedText } from '../services/embedding.service';
import { extractGuidancePromises, resolvePromise } from '../services/groq.service';
import {
  savePromises,
  getPendingPromises,
  updatePromiseStatus,
  getPromises,
  type GuidancePromiseRow,
} from '../services/turso.service';

const MGMT_QUERY = 'management guidance targets commitments promises revenue margin outlook';

// ── Extract Graph ─────────────────────────────────────────────────────────────

const ExtractAnnotation = Annotation.Root({
  ticker:        Annotation<string>,
  quarter:       Annotation<string>,
  mgmtText:      Annotation<string>,
  result:        Annotation<GuidancePromiseRow[]>,
});

async function fetchMgmtTextNode(state: typeof ExtractAnnotation.State) {
  const vector = await embedText(MGMT_QUERY);
  const [ceo, cfo] = await Promise.all([
    searchChunks(vector, { ticker: state.ticker, quarters: [state.quarter], speakerRole: 'CEO' }, 40),
    searchChunks(vector, { ticker: state.ticker, quarters: [state.quarter], speakerRole: 'CFO' }, 40),
  ]);
  const mgmtText = [...ceo, ...cfo]
    .map(c => `[${(c.payload as Record<string, string>).speakerRole} ${(c.payload as Record<string, string>).speakerName ?? ''}] ${(c.payload as Record<string, string>).text}`)
    .join('\n\n');
  return { mgmtText };
}

async function extractNode(state: typeof ExtractAnnotation.State) {
  if (!state.mgmtText.trim()) return { result: [] as GuidancePromiseRow[] };
  const extracted = await extractGuidancePromises(state.ticker, state.quarter, state.mgmtText);
  if (!extracted.length) return { result: [] as GuidancePromiseRow[] };

  const rows = extracted.map(p => ({
    ticker:          state.ticker,
    quarterPromised: state.quarter,
    speaker:         p.speaker,
    category:        p.category,
    verbatimQuote:   p.verbatimQuote,
    timeframe:       p.timeframe,
    confidenceScore: p.confidenceScore,
    directLanguage:  p.directLanguage,
    status:          'pending' as const,
    resolutionNote:  '',
    resolvedInQuarter: '',
  }));

  await savePromises(rows);
  const result = await getPromises(state.ticker, state.quarter);
  return { result };
}

const extractWorkflow = new StateGraph(ExtractAnnotation)
  .addNode('fetch',   fetchMgmtTextNode)
  .addNode('extract', extractNode)
  .addEdge(START,     'fetch')
  .addEdge('fetch',   'extract')
  .addEdge('extract', END);

export const extractPromisesGraph = extractWorkflow.compile();

// ── Resolve Graph ─────────────────────────────────────────────────────────────

const ResolveAnnotation = Annotation.Root({
  ticker:     Annotation<string>,
  newQuarter: Annotation<string>,
  resolved:   Annotation<number>,
});

async function resolveNode(state: typeof ResolveAnnotation.State) {
  const pending = await getPendingPromises(state.ticker);
  if (!pending.length) return { resolved: 0 };

  const vector = await embedText(MGMT_QUERY);
  const [ceo, cfo] = await Promise.all([
    searchChunks(vector, { ticker: state.ticker, quarters: [state.newQuarter], speakerRole: 'CEO' }, 40),
    searchChunks(vector, { ticker: state.ticker, quarters: [state.newQuarter], speakerRole: 'CFO' }, 40),
  ]);
  const newQuarterText = [...ceo, ...cfo]
    .map(c => (c.payload as Record<string, string>).text)
    .join('\n\n');

  if (!newQuarterText.trim()) return { resolved: 0 };

  let resolved = 0;
  for (const promise of pending) {
    try {
      const resolution = await resolvePromise(
        { verbatimQuote: promise.verbatimQuote, timeframe: promise.timeframe, category: promise.category },
        newQuarterText,
        state.newQuarter,
      );
      await updatePromiseStatus(promise.id, resolution.status, resolution.resolutionNote, state.newQuarter);
      resolved++;
    } catch {
      // non-fatal per-promise failure
    }
  }
  return { resolved };
}

const resolveWorkflow = new StateGraph(ResolveAnnotation)
  .addNode('resolve', resolveNode)
  .addEdge(START,     'resolve')
  .addEdge('resolve', END);

export const resolvePromisesGraph = resolveWorkflow.compile();
