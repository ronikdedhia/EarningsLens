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
  // Not part of the default run: it calls Groq for every ingested quarter, and
  // stops when the daily token cap is reached (the 16:00 job continues 3 a day).
  if (args.includes('analysis')) {
    console.log('Promise extraction / resolution / red flags for ingested quarters without them…');
    const { runAnalysisCatchUp } = await import('../src/backend/services/analysis-catchup.service');
    const r = await runAnalysisCatchUp(1000);
    console.log(`  done: ${r.done.join(', ') || 'none'}; ${r.remaining} left${r.stoppedByQuota ? ' (stopped: Groq daily cap)' : ''}`);
  }
  if (want('legacy')) {
    console.log('Results before Mar-2025 + re-read all XBRL for shares/debt/cash…');
    const f = await syncFinancials({ notifyOlderThanDays: 0, includeLegacy: true, reparse: true });
    console.log(`  ${f.stored} quarter rows stored/updated`);
    f.failures.forEach(x => console.log(`  ! ${x}`));
  }
  if (want('fda') || want('orders')) {
    console.log('US FDA events and order wins, last 2 years…');
    const { syncCorporateEvents } = await import('../src/backend/services/corporate-events.service');
    const c = await syncCorporateEvents({ sinceDays: 730, announce: false });
    console.log(`  ${c.fda.length} FDA events, ${c.orders.length} orders (${c.orders.filter(o => o.valueInr != null).length} with a value)`);
    c.failures.forEach(x => console.log(`  ! ${x}`));
  }
  if (want('shareholding')) {
    console.log('Shareholding, last 8 quarters…');
    const { syncShareholding } = await import('../src/backend/services/shareholding.service');
    const s = await syncShareholding({ quarters: 8, announce: false });
    console.log(`  ${s.stored} quarters`);
    s.failures.forEach(x => console.log(`  ! ${x}`));
  }
  if (want('valuation')) {
    console.log('Valuation (2 years of prices)…');
    const { getValuation } = await import('../src/backend/services/valuation.service');
    const { listCompanies } = await import('../src/backend/services/turso.service');
    for (const c of await listCompanies()) {
      const v = await getValuation(c.ticker).catch(e => { console.log(`  ! ${c.ticker}: ${String(e).slice(0, 80)}`); return null; });
      if (v) console.log(`  ${c.ticker.padEnd(11)} P/E ${v.pe.current?.toFixed(1) ?? 'n/a'} (2y ${v.pe.min?.toFixed(1) ?? '-'}–${v.pe.max?.toFixed(1) ?? '-'})  EV/EBITDA ${v.evEbitda.current?.toFixed(1) ?? 'n/a'}  ${v.days} days`);
    }
  }
  if (want('reactions')) {
    console.log('Price reactions…');
    const r = await syncPriceReactions();
    console.log(`  ${r.updated} events measured`);
    r.failures.forEach(x => console.log(`  ! ${x}`));
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
