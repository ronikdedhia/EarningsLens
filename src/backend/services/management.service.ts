import { managementGraph } from '../graphs/management.graph';
import { getManagementScores, type ManagementScoreRow } from './turso.service';

export async function analyzeManagementForTicker(
  ticker: string,
  quarters: string[],
): Promise<ManagementScoreRow[]> {
  const state = await managementGraph.invoke({
    ticker,
    quarters,
    result: [],
  });
  return state.result;
}

export { getManagementScores };
