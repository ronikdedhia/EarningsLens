import axios from 'axios';
import { embedText } from '../services/embedding.service';
import { searchChunks, type ChunkPayload, type SearchFilter } from '../services/qdrant.service';
import { synthesize } from '../services/groq.service';
import { scoreBatch } from '../services/sentiment.service';

async function rerankChunks(query: string, chunks: ChunkPayload[]): Promise<ChunkPayload[]> {
  if (!process.env.COHERE_API_KEY || chunks.length <= 1) return chunks;
  const res = await axios.post<{ results: Array<{ index: number }> }>(
    'https://api.cohere.com/v2/rerank',
    { model: 'rerank-v3.5', query, documents: chunks.map(c => c.text), top_n: chunks.length },
    { headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}` } },
  );
  return res.data.results.map(r => chunks[r.index]);
}

export interface QueryOptions {
  ticker?: string;
  quarters?: string[];
  speakerRole?: string;
  topK?: number;
  beforeDate?: string;  // ISO — no-look-ahead enforcement for backtesting
}

export interface Citation {
  ticker: string;
  quarter: string;
  speaker: string;
  text: string;
  source: string;
}

export interface SentimentPoint {
  quarter: string;
  label: string;
  score: number;
}

export interface RAGResult {
  answer: string;
  citations: Citation[];
  sentimentData: SentimentPoint[];
  queryVector: number[];  // used for query-log embedding; stripped before sending to client
}

const MIN_RELEVANCE_SCORE = 0.5;

export async function runRAGQuery(
  query: string,
  options: QueryOptions = {}
): Promise<RAGResult> {
  const queryVector = await embedText(query);

  const filter: SearchFilter = {
    ticker: options.ticker,
    quarters: options.quarters,
    speakerRole: options.speakerRole,
    beforeDate: options.beforeDate,
  };

  const searchResults = await searchChunks(queryVector, filter, options.topK ?? 8);

  const rawChunks = searchResults
    .filter((r) => r.score > MIN_RELEVANCE_SCORE)
    .map((r) => r.payload as unknown as ChunkPayload);

  if (rawChunks.length === 0) {
    return {
      answer: 'No relevant transcript excerpts found for this query and filter combination.',
      citations: [],
      sentimentData: [],
      queryVector,
    };
  }

  const chunks = await rerankChunks(query, rawChunks);

  const contextBlocks = chunks.map(
    (c) => `[${c.ticker} ${c.quarter} — ${c.speakerRole} ${c.speakerName}]\n${c.text}`
  );

  const [answer, sentimentScores] = await Promise.all([
    synthesize(query, contextBlocks.join('\n\n---\n\n')),
    scoreBatch(chunks.map((c) => c.text)),
  ]);

  const citations: Citation[] = chunks.map((c) => ({
    ticker: c.ticker,
    quarter: c.quarter,
    speaker: `${c.speakerRole} ${c.speakerName}`,
    text: c.text,
    source: c.source,
  }));

  const sentimentData: SentimentPoint[] = chunks.map((c, i) => ({
    quarter: c.quarter,
    label: sentimentScores[i].label,
    score: sentimentScores[i].score,
  }));

  return { answer, citations, sentimentData, queryVector };
}
