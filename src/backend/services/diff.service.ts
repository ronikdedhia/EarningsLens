import { diffGraph, type DiffResult, type KeywordDelta } from '../graphs/diff.graph';

export type { KeywordDelta, DiffResult };

export async function computeDiff(ticker: string, q1: string, q2: string): Promise<DiffResult> {
  const state = await diffGraph.invoke({
    ticker,
    q1,
    q2,
    q1Chunks: [],
    q2Chunks: [],
    result:   null as unknown as DiffResult,
  });
  return state.result;
}
