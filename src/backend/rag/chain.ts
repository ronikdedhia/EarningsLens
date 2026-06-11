import { ragGraph, type Citation, type SentimentPoint } from '../graphs/rag.graph';

export type { Citation, SentimentPoint };

export interface QueryOptions {
  ticker?:      string;
  quarters?:    string[];
  speakerRole?: string;
  topK?:        number;
  beforeDate?:  string;
}

export interface RAGResult {
  answer:        string;
  citations:     Citation[];
  sentimentData: SentimentPoint[];
  queryVector:   number[];
}

export async function runRAGQuery(
  query: string,
  options: QueryOptions = {},
): Promise<RAGResult> {
  const state = await ragGraph.invoke({
    query,
    ticker:      options.ticker,
    quarters:    options.quarters,
    speakerRole: options.speakerRole,
    topK:        options.topK ?? 8,
    beforeDate:  options.beforeDate,
    queryVector:  [],
    rawChunks:    [],
    chunks:       [],
    answer:       '',
    citations:    [],
    sentimentData: [],
  });

  return {
    answer:        state.answer,
    citations:     state.citations,
    sentimentData: state.sentimentData,
    queryVector:   state.queryVector,
  };
}
