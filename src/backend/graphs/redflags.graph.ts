import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { scrollChunks } from '../services/qdrant.service';
import { scanRedFlags, type DetectedRedFlag } from '../services/groq.service';
import { saveRedFlags, getRedFlags, type RedFlagRow } from '../services/turso.service';
import { chunkBlocks, packWindows } from '../utils/transcript';

const RedFlagsAnnotation = Annotation.Root({
  ticker:   Annotation<string>,
  quarter:  Annotation<string>,
  windows:  Annotation<string[]>,
  flags:    Annotation<DetectedRedFlag[]>,
  result:   Annotation<RedFlagRow[]>,
});

async function fetchChunksNode(state: typeof RedFlagsAnnotation.State) {
  // Whole transcript, in transcript order, split into windows the model can read.
  const rawChunks = await scrollChunks({ ticker: state.ticker, quarters: [state.quarter] }, 2000);
  return { windows: packWindows(chunkBlocks(rawChunks)) };
}

async function scanNode(state: typeof RedFlagsAnnotation.State) {
  if (!state.windows.length) return { flags: [] as DetectedRedFlag[] };
  const flags = await scanRedFlags(state.ticker, state.quarter, state.windows);
  return { flags };
}

async function saveNode(state: typeof RedFlagsAnnotation.State) {
  if (!state.flags.length) return { result: [] as RedFlagRow[] };
  await saveRedFlags(state.flags.map(f => ({
    ticker:   state.ticker,
    quarter:  state.quarter,
    flagType: f.flagType,
    severity: f.severity,
    evidence: f.evidence,
  })));
  const result = await getRedFlags(state.ticker, state.quarter);
  return { result };
}

const workflow = new StateGraph(RedFlagsAnnotation)
  .addNode('fetch', fetchChunksNode)
  .addNode('scan',  scanNode)
  .addNode('save',  saveNode)
  .addEdge(START,   'fetch')
  .addEdge('fetch', 'scan')
  .addConditionalEdges('scan',
    state => state.flags.length ? 'save' : 'done',
    { save: 'save', done: END }
  )
  .addEdge('save', END);

export const redFlagsGraph = workflow.compile();
