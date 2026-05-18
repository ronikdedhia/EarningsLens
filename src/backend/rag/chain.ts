import { embedText } from '@/backend/services/embedding.service';
import { searchChunks, type ChunkPayload, type SearchFilter } from '@/backend/services/qdrant.service';
import { synthesize } from '@/backend/services/groq.service';
import { scoreBatch } from '@/backend/services/sentiment.service';

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

  const chunks = searchResults
    .filter((r) => r.score > MIN_RELEVANCE_SCORE)
    .map((r) => r.payload as unknown as ChunkPayload);

  if (chunks.length === 0) {
    return {
      answer: 'No relevant transcript excerpts found for this query and filter combination.',
      citations: [],
      sentimentData: [],
      queryVector,
    };
  }

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
