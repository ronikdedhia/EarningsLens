import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import axios from 'axios';
import { embedText } from '../services/embedding.service';
import { searchChunks, type ChunkPayload, type SearchFilter } from '../services/qdrant.service';
import { synthesize } from '../services/groq.service';
import { scoreBatch } from '../services/sentiment.service';

// ── State ─────────────────────────────────────────────────────────────────────

const RAGAnnotation = Annotation.Root({
  // inputs
  query:       Annotation<string>,
  ticker:      Annotation<string | undefined>,
  quarters:    Annotation<string[] | undefined>,
  speakerRole: Annotation<string | undefined>,
  topK:        Annotation<number>,
  beforeDate:  Annotation<string | undefined>,
  // intermediate
  queryVector:  Annotation<number[]>,
  rawChunks:    Annotation<ChunkPayload[]>,
  chunks:       Annotation<ChunkPayload[]>,
  // outputs
  answer:       Annotation<string>,
  citations:    Annotation<Citation[]>,
  sentimentData: Annotation<SentimentPoint[]>,
});

export interface Citation {
  ticker:  string;
  quarter: string;
  speaker: string;
  text:    string;
  source:  string;
}

export interface SentimentPoint {
  quarter: string;
  label:   string;
  score:   number;
}

const MIN_RELEVANCE_SCORE = 0.5;

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function embedQueryNode(state: typeof RAGAnnotation.State) {
  const queryVector = await embedText(state.query);
  return { queryVector };
}

async function retrieveNode(state: typeof RAGAnnotation.State) {
  const filter: SearchFilter = {
    ticker:      state.ticker,
    quarters:    state.quarters,
    speakerRole: state.speakerRole,
    beforeDate:  state.beforeDate,
  };
  const results = await searchChunks(state.queryVector, filter, state.topK);
  const rawChunks = results
    .filter(r => r.score > MIN_RELEVANCE_SCORE)
    .map(r => r.payload as unknown as ChunkPayload);
  return { rawChunks };
}

async function rerankNode(state: typeof RAGAnnotation.State) {
  const { rawChunks, query } = state;
  if (!process.env.COHERE_API_KEY || rawChunks.length <= 1) {
    return { chunks: rawChunks };
  }
  try {
    const res = await axios.post<{ results: Array<{ index: number }> }>(
      'https://api.cohere.com/v2/rerank',
      { model: 'rerank-v3.5', query, documents: rawChunks.map(c => c.text), top_n: rawChunks.length },
      { headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}` } },
    );
    return { chunks: res.data.results.map(r => rawChunks[r.index]) };
  } catch {
    return { chunks: rawChunks };
  }
}

async function synthesizeNode(state: typeof RAGAnnotation.State) {
  const contextBlocks = state.chunks.map(
    c => `[${c.ticker} ${c.quarter} — ${c.speakerRole} ${c.speakerName}]\n${c.text}`
  );
  const answer = await synthesize(state.query, contextBlocks.join('\n\n---\n\n'));
  return { answer };
}

async function sentimentNode(state: typeof RAGAnnotation.State) {
  const scores = await scoreBatch(state.chunks.map(c => c.text));
  const citations: Citation[] = state.chunks.map(c => ({
    ticker:  c.ticker,
    quarter: c.quarter,
    speaker: `${c.speakerRole} ${c.speakerName}`,
    text:    c.text,
    source:  c.source,
  }));
  const sentimentData: SentimentPoint[] = state.chunks.map((c, i) => ({
    quarter: c.quarter,
    label:   scores[i].label,
    score:   scores[i].score,
  }));
  return { citations, sentimentData };
}

function emptyResultNode(_state: typeof RAGAnnotation.State) {
  return {
    answer:        'No relevant transcript excerpts found for this query and filter combination.',
    citations:     [] as Citation[],
    sentimentData: [] as SentimentPoint[],
  };
}

// ── Graph ─────────────────────────────────────────────────────────────────────

const workflow = new StateGraph(RAGAnnotation)
  .addNode('embed',       embedQueryNode)
  .addNode('retrieve',    retrieveNode)
  .addNode('rerank',      rerankNode)
  .addNode('synthesize',  synthesizeNode)
  .addNode('sentiment',   sentimentNode)
  .addNode('empty',       emptyResultNode)
  .addEdge(START, 'embed')
  .addEdge('embed', 'retrieve')
  .addConditionalEdges('retrieve',
    state => state.rawChunks.length === 0 ? 'empty' : 'rerank',
    { empty: 'empty', rerank: 'rerank' }
  )
  .addEdge('rerank',     'synthesize')
  .addEdge('synthesize', 'sentiment')
  .addEdge('sentiment',  END)
  .addEdge('empty',      END);

export const ragGraph = workflow.compile();
