import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { scrollChunks, searchChunks, type ChunkPayload } from '../services/qdrant.service';
import { embedText } from '../services/embedding.service';
import { extractGuidancePromises, resolvePromise } from '../services/groq.service';
import {
  savePromises,
  getPendingPromises,
  updatePromiseStatus,
  getPromises,
  type GuidancePromiseRow,
} from '../services/turso.service';
import { chunkBlocks, packWindows, quarterToInt } from '../utils/transcript';
import { financialsEvidence } from '../services/financials.service';

// Analysts ask, moderators route; neither makes commitments. 'Other' stays in
// because MDs and chairmen with unrecognised titles land there.
const MGMT_ROLES = new Set<ChunkPayload['speakerRole']>(['CEO', 'CFO', 'Other']);

/** Promises made before `newQuarter` are the only ones it can settle. */
export function promisesDueFor<T extends { quarterPromised: string }>(pending: T[], newQuarter: string): T[] {
  const target = quarterToInt(newQuarter);
  return pending.filter(p => {
    const made = quarterToInt(p.quarterPromised);
    return made > 0 && target > 0 && made < target;
  });
}

// ── Extract Graph ─────────────────────────────────────────────────────────────

const ExtractAnnotation = Annotation.Root({
  ticker:   Annotation<string>,
  quarter:  Annotation<string>,
  windows:  Annotation<string[]>,
  result:   Annotation<GuidancePromiseRow[]>,
});

async function fetchMgmtTextNode(state: typeof ExtractAnnotation.State) {
  // All management remarks for the quarter, not the top-80 vector hits cut to 8,000 chars.
  const chunks = await scrollChunks({ ticker: state.ticker, quarters: [state.quarter] }, 2000);
  const mgmt = chunks.filter(c => MGMT_ROLES.has(c.speakerRole));
  return { windows: packWindows(chunkBlocks(mgmt)) };
}

async function extractNode(state: typeof ExtractAnnotation.State) {
  if (!state.windows.length) return { result: [] as GuidancePromiseRow[] };

  const extracted = await extractGuidancePromises(state.ticker, state.quarter, state.windows);
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
  // Previously every pending promise was checked, including ones made in this
  // same quarter (extraction and resolution ran in parallel at ingest), so a
  // quarter could "deliver" its own promises.
  const pending = promisesDueFor(await getPendingPromises(state.ticker), state.newQuarter);
  if (!pending.length) return { resolved: 0 };

  // The quarter's reported numbers from the results XBRL, so revenue and margin
  // promises are checked against figures, not only against what was said.
  const reported = await financialsEvidence(state.ticker, state.newQuarter).catch(() => '');

  let resolved = 0;
  for (const promise of pending) {
    try {
      // Evidence specific to this promise, instead of one generic top-80 retrieval.
      const vector = await embedText(promise.verbatimQuote);
      const hits = await searchChunks(vector, { ticker: state.ticker, quarters: [state.newQuarter] }, 10);
      const transcript = hits
        .map(h => h.payload as unknown as ChunkPayload)
        .map(c => `[${c.speakerRole} ${c.speakerName ?? ''}] ${c.text}`)
        .join('\n\n');
      if (!transcript.trim() && !reported) continue;
      const evidence = [reported, transcript].filter(Boolean).join('\n\n');

      const resolution = await resolvePromise(
        { verbatimQuote: promise.verbatimQuote, timeframe: promise.timeframe, category: promise.category },
        evidence,
        state.newQuarter,
      );
      if (resolution.status === 'pending') continue; // not due yet; check again next quarter
      await updatePromiseStatus(promise.id, resolution.status, resolution.resolutionNote, state.newQuarter);
      resolved++;
    } catch (err) {
      // Leave it pending. A failed call is not evidence the promise was missed.
      console.error(`[promises] resolve ${promise.id} failed:`, String(err).slice(0, 200));
    }
  }

  return { resolved };
}

const resolveWorkflow = new StateGraph(ResolveAnnotation)
  .addNode('resolve', resolveNode)
  .addEdge(START,     'resolve')
  .addEdge('resolve', END);

export const resolvePromisesGraph = resolveWorkflow.compile();
