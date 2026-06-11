import { redFlagsGraph } from '../graphs/redflags.graph';
import { getRedFlags, type RedFlagRow } from './turso.service';

export async function scanAndSaveRedFlags(
  ticker: string,
  quarter: string,
): Promise<RedFlagRow[]> {
  const state = await redFlagsGraph.invoke({
    ticker,
    quarter,
    chunks: '',
    flags:  [],
    result: [],
  });
  return state.result;
}

export { getRedFlags };
