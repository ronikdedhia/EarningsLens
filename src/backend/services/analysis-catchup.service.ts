import { db } from './turso.service';
import { extractPromisesForQuarter, resolvePromisesForQuarter } from './promises.service';
import { scanAndSaveRedFlags } from './redflags.service';
import { DailyLimitError } from './llm';

/**
 * Ingested quarters that never got promise extraction or a red-flag scan,
 * usually because Groq's daily token cap ran out. Oldest first, so promises
 * exist before the next quarter resolves them.
 */
export async function quartersMissingAnalysis(): Promise<Array<{ ticker: string; quarter: string }>> {
  const { rows } = await db().execute(
    `SELECT qi.ticker, qi.quarter FROM quarter_index qi
     WHERE qi.ingested_at IS NOT NULL AND qi.ingested_at != ''
       AND NOT EXISTS (SELECT 1 FROM red_flags rf WHERE rf.ticker = qi.ticker AND rf.quarter = qi.quarter)
       AND NOT EXISTS (SELECT 1 FROM guidance_promises gp WHERE gp.ticker = qi.ticker AND gp.quarter_promised = qi.quarter)
     ORDER BY qi.fiscal_year, qi.quarter, qi.ticker`,
  );
  return rows.map(r => ({ ticker: String(r.ticker), quarter: String(r.quarter) }));
}

/**
 * Analyses up to `limit` such quarters; stops at the first daily-cap error.
 * A quarter with genuinely zero promises and zero flags is retried each day,
 * which costs a little; the alternative is a separate "analysed" marker table.
 */
export async function runAnalysisCatchUp(limit = 3): Promise<{ done: string[]; remaining: number; stoppedByQuota: boolean }> {
  const todo = await quartersMissingAnalysis();
  const done: string[] = [];
  for (const { ticker, quarter } of todo.slice(0, limit)) {
    try {
      await extractPromisesForQuarter(ticker, quarter);
      await resolvePromisesForQuarter(ticker, quarter);
      await scanAndSaveRedFlags(ticker, quarter);
      done.push(`${ticker} ${quarter}`);
    } catch (err) {
      if (err instanceof DailyLimitError) return { done, remaining: todo.length - done.length, stoppedByQuota: true };
      console.error(`[catch-up] ${ticker} ${quarter}:`, String(err).slice(0, 200));
    }
  }
  return { done, remaining: todo.length - done.length, stoppedByQuota: false };
}
