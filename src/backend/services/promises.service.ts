import { extractPromisesGraph, resolvePromisesGraph } from '../graphs/promises.graph';
import { getPromises, type GuidancePromiseRow } from './turso.service';

export async function extractPromisesForQuarter(
  ticker: string,
  quarter: string,
): Promise<GuidancePromiseRow[]> {
  const state = await extractPromisesGraph.invoke({
    ticker,
    quarter,
    mgmtText: '',
    result:   [],
  });
  return state.result;
}

export async function resolvePromisesForQuarter(
  ticker: string,
  newQuarter: string,
): Promise<{ resolved: number }> {
  const state = await resolvePromisesGraph.invoke({
    ticker,
    newQuarter,
    resolved: 0,
  });
  return { resolved: state.resolved };
}

export { getPromises };
