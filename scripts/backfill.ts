/**
 * One-off history load for the market features. Safe to re-run; nothing is sent to Telegram.
 *
 *   npx tsx scripts/backfill.ts            # everything
 *   npx tsx scripts/backfill.ts signals financials meetings transcripts reactions
 *
 * signals      insider trades since 2026-05-03 (when NSE's current format starts),
 *              SAST, pledge snapshot, bulk/block deals for the last 365 days
 * financials   every results XBRL from NSE's Integrated Filing (periods from Mar-2025)
 * meetings     board meetings for the next 45 days
 * transcripts  exact filing time for already-ingested transcripts (red-flag reactions need it)
 * reactions    1/5/20-day price moves for everything above
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { syncSignals } from '../src/backend/services/signals.service';
import { syncFinancials } from '../src/backend/services/financials.service';
import { syncBoardMeetings } from '../src/backend/services/briefs.service';
import { syncPriceReactions } from '../src/backend/services/reactions.service';
import { db } from '../src/backend/services/turso.service';
import { discoverPdfUrl } from '../src/backend/services/concall-discovery.service';

async function backfillTranscriptDates(): Promise<void> {
  const { rows } = await db().execute(
    `SELECT ticker, quarter FROM quarter_index
     WHERE (transcript_filed_at IS NULL OR transcript_filed_at = '') AND ingested_at IS NOT NULL AND ingested_at != ''`,
  );
  let found = 0;
  for (const r of rows) {
    const hit = await discoverPdfUrl(String(r.ticker), String(r.quarter)).catch(() => null);
    if (!hit?.filedAt) continue;
    await db().execute({
      sql: 'UPDATE quarter_index SET transcript_filed_at = ? WHERE ticker = ? AND quarter = ?',
      args: [hit.filedAt, r.ticker, r.quarter],
    });
    found++;
  }
  console.log(`  transcript dates: ${found}/${rows.length} found on NSE`);
}

async function main() {
  const args = process.argv.slice(2);
  const want = (s: string) => !args.length || args.includes(s);
  const daysSinceMay = Math.ceil((Date.now() - Date.parse('2026-05-03T00:00:00+05:30')) / 86_400_000);

  if (want('signals')) {
    console.log('Signals…');
    const s = await syncSignals({ sinceDays: Math.max(365, daysSinceMay) });
    console.log(`  ${s.added.length} new rows`);
    s.failures.forEach(f => console.log(`  ! ${f}`));
  }
  if (want('financials')) {
    console.log('Financials…');
    const f = await syncFinancials({ notifyOlderThanDays: 0 });
    console.log(`  ${f.stored} quarter rows stored`);
    f.failures.forEach(x => console.log(`  ! ${x}`));
  }
  if (want('meetings')) {
    console.log('Board meetings…');
    const m = await syncBoardMeetings();
    console.log(`  ${m.stored} meetings`);
    m.failures.forEach(x => console.log(`  ! ${x}`));
  }
  if (want('transcripts')) {
    console.log('Transcript filing dates…');
    await backfillTranscriptDates();
  }
  if (want('reactions')) {
    console.log('Price reactions…');
    const r = await syncPriceReactions();
    console.log(`  ${r.updated} events measured`);
    r.failures.forEach(x => console.log(`  ! ${x}`));
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
