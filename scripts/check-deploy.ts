/**
 * Is the latest commit live on both servers?
 *
 *   npm run check-deploy            # compare against origin/main
 *   npm run check-deploy -- --wait  # poll every 30s for up to 15 min until both match
 *
 * Reads BACKEND_PUBLIC_URL and FRONTEND_URL from .env.local.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import { execSync } from 'child_process';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const BACKEND = (process.env.BACKEND_PUBLIC_URL ?? '').replace(/\/$/, '');
const FRONTEND = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');

async function getJson(url: string): Promise<Record<string, unknown> | string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) }); // Render free tier cold-starts
    const text = await res.text();
    try { return JSON.parse(text); } catch { return `HTTP ${res.status}, not JSON (old deploy without /version?)`; }
  } catch (err) {
    return `unreachable: ${String((err as Error).message ?? err)}`;
  }
}

async function check(expected: string): Promise<boolean> {
  const short = (s: unknown) => (typeof s === 'string' ? s.slice(0, 7) : String(s));
  const [be, fe, health] = await Promise.all([
    getJson(`${BACKEND}/version`), getJson(`${FRONTEND}/version`), getJson(`${BACKEND}/health`),
  ]);
  let ok = true;

  console.log(`expected commit  ${short(expected)}  (origin/main)`);
  if (typeof be === 'string') { console.log(`backend   ✗ ${be}`); ok = false; }
  else {
    const match = be.commit === expected;
    ok &&= match;
    console.log(`backend   ${match ? '✓' : '✗'} ${short(be.commit)}  started ${be.startedAt}  health=${typeof health === 'string' ? health : health.status}`);
    console.log(`          models ${JSON.stringify(be.models)}`);
    // Ask Telegram itself: the server's boot-time re-registration can fail on a
    // network blip while the webhook set earlier is still in place and working.
    const token = process.env.TELEGRAM_ACCESS_TOKEN;
    if (token) {
      const info = await getJson(`https://api.telegram.org/bot${token}/getWebhookInfo`);
      const r = (typeof info === 'string' ? {} : (info.result ?? {})) as { url?: string; pending_update_count?: number; last_error_message?: string; last_error_date?: number };
      const recentError = r.last_error_date && Date.now() / 1000 - r.last_error_date < 86_400 ? r.last_error_message : undefined;
      const okBot = r.url === `${BACKEND}/api/telegram/webhook` && !recentError && (r.pending_update_count ?? 0) < 5;
      console.log(`          ${okBot ? '✓' : '✗'} telegram bot: webhook ${r.url === `${BACKEND}/api/telegram/webhook` ? 'set' : `wrong (${r.url || 'none'})`}` +
        `, pending ${r.pending_update_count ?? '?'}${recentError ? `, last error: ${recentError}` : ''}`);
      ok &&= okBot;
    }
    const missing = Object.entries((be.configured ?? {}) as Record<string, boolean>).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) { console.log(`          ✗ missing on Render: ${missing.join(', ')}`); ok = false; }
    // Scheduled jobs run on the Mumbai VM; each should have run within its cadence.
    const jobs = (be.jobs ?? []) as Array<{ name: string; host: string; startedAt: string; finishedAt: string | null; ok: boolean | null; summary: string }>;
    const maxAgeH: Record<string, number> = { daily: 26, evening: 26, refresh: 24 * 8 };
    for (const name of ['daily', 'evening', 'refresh']) {
      const j = jobs.find(x => x.name === name);
      if (!j) { console.log(`job ${name.padEnd(8)} – never run yet`); continue; }
      const ageH = (Date.now() - Date.parse(j.startedAt)) / 3_600_000;
      const fresh = ageH <= maxAgeH[name] && j.ok !== false;
      console.log(`job ${name.padEnd(8)} ${fresh ? '✓' : '✗'} ${j.ok === null ? 'running' : j.ok ? 'ok' : 'FAILED'} on ${j.host}, ${ageH.toFixed(1)}h ago — ${j.summary.slice(0, 90)}`);
    }
  }
  if (typeof fe === 'string') { console.log(`frontend  ✗ ${fe}`); ok = false; }
  else {
    const match = fe.commit === expected;
    ok &&= match;
    console.log(`frontend  ${match ? '✓' : '✗'} ${short(fe.commit)}  ${fe.env}  api=${fe.apiUrl}`);
  }
  return ok;
}

async function main() {
  execSync('git fetch -q origin', { stdio: 'ignore' });
  const expected = execSync('git rev-parse origin/main').toString().trim();
  const wait = process.argv.includes('--wait');
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const ok = await check(expected);
    if (ok) { console.log('\nBoth servers are running the latest commit.'); return; }
    if (!wait || Date.now() > deadline) { console.log('\nNot fully deployed.'); process.exit(1); }
    console.log('…waiting 30s\n');
    await new Promise(r => setTimeout(r, 30_000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
