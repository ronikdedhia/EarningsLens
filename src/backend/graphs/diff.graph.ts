import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { scrollChunks, type ChunkPayload } from '../services/qdrant.service';
import { semanticDiff, type TranscriptDiffResult } from '../services/groq.service';
import { getManagementScores } from '../services/turso.service';

export interface KeywordDelta {
  word:      string;
  q1Count:   number;
  q2Count:   number;
  delta:     number;
  pctChange: number | null;
}

export interface DiffResult {
  q1:            string;
  q2:            string;
  ticker:        string;
  keywordDeltas: KeywordDelta[];
  toneScoreDelta: number | null;
  q1ToneScore:   number | null;
  q2ToneScore:   number | null;
  semantic:      TranscriptDiffResult;
}

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','are','was','were','be','been','have','has','had',
  'do','does','did','will','would','could','should','may','might',
  'this','that','these','those','we','our','us','you','your','it',
  'its','they','their','them','as','not','no','so','if','also',
  'quarter','year','crore','lakh','million','billion','rupee','percent',
  'which','what','when','where','who','how','said','very','just',
  'during','over','under','about','than','more','some','into','been',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
}

function buildFreqMap(chunks: ChunkPayload[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of chunks) {
    for (const word of tokenize(c.text)) {
      map.set(word, (map.get(word) ?? 0) + 1);
    }
  }
  return map;
}

// ── State ─────────────────────────────────────────────────────────────────────

const DiffAnnotation = Annotation.Root({
  ticker:    Annotation<string>,
  q1:        Annotation<string>,
  q2:        Annotation<string>,
  q1Chunks:  Annotation<ChunkPayload[]>,
  q2Chunks:  Annotation<ChunkPayload[]>,
  result:    Annotation<DiffResult>,
});

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function fetchChunksNode(state: typeof DiffAnnotation.State) {
  const [q1Chunks, q2Chunks] = await Promise.all([
    scrollChunks({ ticker: state.ticker, quarters: [state.q1] }, 500),
    scrollChunks({ ticker: state.ticker, quarters: [state.q2] }, 500),
  ]);
  return { q1Chunks, q2Chunks };
}

async function computeDiffNode(state: typeof DiffAnnotation.State) {
  const { ticker, q1, q2, q1Chunks, q2Chunks } = state;

  const q1Map = buildFreqMap(q1Chunks);
  const q2Map = buildFreqMap(q2Chunks);

  const allWords = new Set([...q1Map.keys(), ...q2Map.keys()]);
  const deltas: KeywordDelta[] = [];

  for (const word of allWords) {
    const c1 = q1Map.get(word) ?? 0;
    const c2 = q2Map.get(word) ?? 0;
    if (c1 + c2 < 2) continue;
    deltas.push({
      word,
      q1Count:   c1,
      q2Count:   c2,
      delta:     c2 - c1,
      pctChange: c1 > 0 ? Math.round(((c2 - c1) / c1) * 100) : null,
    });
  }

  const keywordDeltas = deltas
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 30);

  const mgmtScores = await getManagementScores(ticker);
  const s1 = mgmtScores.find(s => s.quarter === q1);
  const s2 = mgmtScores.find(s => s.quarter === q2);
  const q1ToneScore = s1 ? Math.round((s1.confidence + s1.transparency) / 2) : null;
  const q2ToneScore = s2 ? Math.round((s2.confidence + s2.transparency) / 2) : null;

  const q1Text = q1Chunks.map(c => c.text).join('\n');
  const q2Text = q2Chunks.map(c => c.text).join('\n');
  const semantic = await semanticDiff(ticker, q1, q2, q1Text, q2Text);

  const result: DiffResult = {
    q1, q2, ticker,
    keywordDeltas,
    toneScoreDelta: q1ToneScore !== null && q2ToneScore !== null ? q2ToneScore - q1ToneScore : null,
    q1ToneScore,
    q2ToneScore,
    semantic,
  };

  return { result };
}

// ── Graph ─────────────────────────────────────────────────────────────────────

const workflow = new StateGraph(DiffAnnotation)
  .addNode('fetch',   fetchChunksNode)
  .addNode('compute', computeDiffNode)
  .addEdge(START,     'fetch')
  .addEdge('fetch',   'compute')
  .addEdge('compute', END);

export const diffGraph = workflow.compile();
