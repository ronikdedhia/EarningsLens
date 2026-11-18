/**
 * Runs one scheduled job and exits. Used by cron on the Mumbai VM, because NSE
 * blocks Render's US servers (403 since 2026-11-18).
 *
 *   npx tsx scripts/run-job.ts daily     # 16:00 IST: filings, signals, results, FDA, orders, shareholding, prices
 *   npx tsx scripts/run-job.ts evening   # 19:00 IST: results-day briefs
 *   npx tsx scripts/run-job.ts refresh   # Fri 12:00 IST: new transcripts for every company
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
// Ingest here instead of queueing to Render through QStash.
process.env.QSTASH_TOKEN = '';

import { recordJob } from '../src/backend/services/job-runs.service';

async function main() {
  const job = process.argv[2];
  if (job === 'daily') {
    const { runDailyJobs } = await import('../src/backend/services/jobs.service');
    await recordJob('daily', () => runDailyJobs());
  } else if (job === 'evening') {
    const { runEveningJobs } = await import('../src/backend/services/jobs.service');
    await recordJob('evening', () => runEveningJobs(), r => `briefs sent: ${r.sent.join(', ') || 'none'}; failures: ${r.failures.length}`);
  } else if (job === 'refresh') {
    const { runRefreshAll } = await import('../src/backend/routes/companies.route');
    const { waitForBackgroundAnalysis } = await import('../src/backend/graphs/ingest.graph');
    await recordJob('refresh', async () => { await runRefreshAll(); await waitForBackgroundAnalysis(); return 'done'; }, r => r);
  } else {
    console.error('usage: run-job.ts daily|evening|refresh');
    process.exit(2);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
