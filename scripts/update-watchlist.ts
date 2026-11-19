/**
 * Makes the database match src/backend/watchlist.ts.
 *
 *   npx tsx scripts/update-watchlist.ts              # dry run: shows what would change
 *   npx tsx scripts/update-watchlist.ts --apply      # deletes removed tickers' data, adds new companies
 *   npx tsx scripts/update-watchlist.ts --apply --discover
 *                                                    # also fetches + ingests the last 4 transcripts
 *                                                    # for watchlist companies with none (uses Groq)
 *
 * Deletion is permanent: transcripts in Qdrant, sentiment, promises, red flags,
 * filings, financials, signals and price reactions for REMOVED_TICKERS.
 * Run `npm run db:init` first so the newer tables exist.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { WATCHLIST, REMOVED_TICKERS } from '../src/backend/watchlist';
import { db, listCompanies, addCompany, getIngestedQuarters } from '../src/backend/services/turso.service';
import { deleteTickerPoints } from '../src/backend/services/qdrant.service';

const TICKER_TABLES = [
  'quarter_index', 'sentiment_scores', 'management_scores', 'red_flags', 'guidance_promises',
  'daily_filings', 'user_companies', 'insights', 'query_log', 'price_reactions', 'price_history',
  'quarterly_financials', 'board_meetings', 'market_signals', 'shareholding', 'order_wins', 'fda_events',
  'companies',
];

async function countOrDelete(table: string, tickers: string[], apply: boolean): Promise<number | string> {
  const marks = tickers.map(() => '?').join(',');
  try {
    const { rows } = await db().execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ticker IN (${marks})`, args: tickers });
    const n = Number(rows[0]?.n ?? 0);
    if (apply && n) await db().execute({ sql: `DELETE FROM ${table} WHERE ticker IN (${marks})`, args: tickers });
    return n;
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    return /no such table/i.test(msg) ? 'no table' : `error: ${msg.slice(0, 60)}`;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const discover = process.argv.includes('--discover');

  const existing = await listCompanies();
  const inDb = new Set(existing.map(c => c.ticker));
  // Every removed ticker, not only those in `companies`: old transcripts can
  // outlive their company row (the large-caps were dropped from the seed but
  // their quarters and vectors stayed).
  const toRemove = [...REMOVED_TICKERS];
  const toAdd = WATCHLIST.filter(c => !inDb.has(c.ticker));
  const watch = new Set(WATCHLIST.map(c => c.ticker));
  const untracked = existing.filter(c => !watch.has(c.ticker) && !REMOVED_TICKERS.includes(c.ticker));

  console.log(apply ? '\nAPPLYING CHANGES\n' : '\nDRY RUN (pass --apply to change anything)\n');
  console.log('Currently in DB:', [...inDb].sort().join(', ') || '(none)');
  console.log('Remove:', toRemove.join(', ') || '(none)');
  console.log('Add:   ', toAdd.map(c => c.ticker).join(', ') || '(none)');
  if (untracked.length) {
    console.log('Left alone (in DB, not in watchlist.ts, not in REMOVED_TICKERS):', untracked.map(c => c.ticker).join(', '));
  }

  if (toRemove.length) {
    console.log(`\nRows for ${toRemove.join(', ')}:`);
    for (const table of TICKER_TABLES) {
      const n = await countOrDelete(table, toRemove, apply);
      console.log(`  ${table.padEnd(22)} ${n}`);
    }
    try {
      const q = await deleteTickerPoints(toRemove, !apply);
      for (const [name, n] of Object.entries(q)) console.log(`  qdrant:${name.padEnd(15)} ${n}`);
    } catch (err) {
      console.log(`  qdrant: ${String((err as Error).message ?? err).slice(0, 80)}`);
    }
    // Sector narratives for sectors with no companies left are stale.
    const remaining = new Set(existing.filter(c => !toRemove.includes(c.ticker)).map(c => c.sector)
      .concat(toAdd.map(c => c.sector)));
    const { rows } = await db().execute('SELECT DISTINCT sector FROM sector_narratives');
    const stale = rows.map(r => String(r.sector)).filter(s => !remaining.has(s));
    if (stale.length) {
      console.log(`  sector_narratives for ${stale.join(', ')}`);
      if (apply) {
        await db().execute({ sql: `DELETE FROM sector_narratives WHERE sector IN (${stale.map(() => '?').join(',')})`, args: stale });
      }
    }
  }

  // The collection's vector size must match the embedder. It can only be
  // recreated when empty, which is the case once the removed tickers are gone.
  try {
    const { embedText } = await import('../src/backend/services/embedding.service');
    const { recreateCollectionIfEmpty } = await import('../src/backend/services/qdrant.service');
    const dim = (await embedText('dimension probe')).length;
    console.log(`\n${await recreateCollectionIfEmpty(dim, !apply)}`);
  } catch (err) {
    console.log(`\nVector size check failed: ${String((err as Error).message ?? err).slice(0, 120)}`);
  }

  if (apply) {
    for (const c of toAdd) await addCompany(c.ticker, c.name, c.sector, c.bseCode);
    if (toAdd.length) console.log(`\nAdded ${toAdd.length} companies.`);
  }

  if (apply && discover) {
    const { discoverAndIngestTicker } = await import('../src/backend/routes/companies.route');
    for (const c of WATCHLIST) {
      // discoverAndIngestTicker skips quarters already ingested, so re-runs resume.
      if ((await getIngestedQuarters(c.ticker)).length >= 4) continue;
      console.log(`\nDiscovering transcripts for ${c.ticker}…`);
      for (const r of await discoverAndIngestTicker(c.ticker, 4)) console.log(`  ${r.quarter}: ${r.status}`);
    }
    console.log('\nWaiting for promise extraction and red-flag scans…');
    const { waitForBackgroundAnalysis } = await import('../src/backend/graphs/ingest.graph');
    await waitForBackgroundAnalysis();
  } else if (toAdd.length) {
    console.log('\nNew companies have no transcripts yet. Re-run with --apply --discover, or wait for the Friday refresh (last 2 quarters).');
  }

  console.log(apply ? '\nDone.' : '\nNothing changed.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
