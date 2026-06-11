import { Router } from 'express';
import { Client } from '@upstash/qstash';
import { QdrantClient } from '@qdrant/js-client-rest';
import { notify } from '../services/telegram.service';

export const keepaliveRouter = Router();

// Lazy import to avoid circular dep — server.ts exports sendDailyReport
let _sendDailyReport: (() => Promise<void>) | null = null;
export function setDailyReportHandler(fn: () => Promise<void>) { _sendDailyReport = fn; }

keepaliveRouter.post('/daily-report', async (_, res) => {
  if (_sendDailyReport) await _sendDailyReport();
  res.json({ status: 'ok' });
});

keepaliveRouter.post('/ping', async (_, res) => {
  try {
    const qdrant = new QdrantClient({
      url: process.env.QDRANT_URL!,
      apiKey: process.env.QDRANT_API_KEY,
    });
    const result = await qdrant.getCollections();
    res.json({ status: 'ok', collections: result.collections.length });
  } catch (err) {
    notify(`⚠️ *EarningsLens keepalive FAILED*\n\`${String(err).slice(0, 200)}\``);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

async function pingQdrant() {
  const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL!,
    apiKey: process.env.QDRANT_API_KEY,
  });
  const result = await qdrant.getCollections();
  console.log('[keepalive] Qdrant pinged —', result.collections.length, 'collections');
}

export async function registerKeepaliveSchedule() {
  // Always run a local interval so Qdrant stays alive regardless of QStash config
  setInterval(async () => {
    try {
      await pingQdrant();
    } catch (err) {
      console.error('[keepalive] Qdrant ping failed:', err);
      notify(`⚠️ *EarningsLens keepalive FAILED*\n\`${String(err).slice(0, 200)}\``);
    }
  }, 10 * 60 * 1000); // every 10 min
  console.log('[keepalive] Local interval started — pinging Qdrant every 10 min');

  const token = process.env.QSTASH_TOKEN;
  const backendUrl = process.env.BACKEND_PUBLIC_URL;
  if (!token || !backendUrl) return;

  const qstash = new Client({ token });
  const existing = await qstash.schedules.list();

  const pingDest = `${backendUrl}/api/keepalive/ping`;
  if (!existing.some((s: { destination: string }) => s.destination === pingDest)) {
    await qstash.schedules.create({ destination: pingDest, cron: '*/14 * * * *' });
    console.log('[keepalive] QStash ping schedule registered →', pingDest);
  }
}

export async function registerDailyReportSchedule() {
  const token = process.env.QSTASH_TOKEN;
  const backendUrl = process.env.BACKEND_PUBLIC_URL;
  if (!token || !backendUrl) {
    console.log('[daily-report] QSTASH_TOKEN or BACKEND_PUBLIC_URL not set — relying on node-cron only');
    return;
  }

  const dest = `${backendUrl}/api/keepalive/daily-report`;
  const qstash = new Client({ token });
  const existing = await qstash.schedules.list();

  if (existing.some((s: { destination: string }) => s.destination === dest)) return;

  // 14:00 IST = 08:30 UTC
  await qstash.schedules.create({ destination: dest, cron: '30 8 * * *' });
  console.log('[daily-report] QStash schedule registered → 14:00 IST daily');
}

export async function registerDailyFilingsSchedule() {
  const token = process.env.QSTASH_TOKEN;
  const backendUrl = process.env.BACKEND_PUBLIC_URL;
  if (!token || !backendUrl) {
    console.log('[daily-filings] QSTASH_TOKEN or BACKEND_PUBLIC_URL not set — relying on node-cron only');
    return;
  }

  const dest = `${backendUrl}/api/daily-filings/run`;
  const qstash = new Client({ token });
  const existing = await qstash.schedules.list();

  if (existing.some((s: { destination: string }) => s.destination === dest)) return;

  // 16:00 IST = 10:30 UTC
  await qstash.schedules.create({ destination: dest, cron: '30 10 * * *' });
  console.log('[daily-filings] QStash schedule registered → 16:00 IST daily');
}

export async function registerRefreshSchedule() {
  const token = process.env.QSTASH_TOKEN;
  const backendUrl = process.env.BACKEND_PUBLIC_URL;
  if (!token || !backendUrl) {
    console.log('[refresh] QSTASH_TOKEN or BACKEND_PUBLIC_URL not set — relying on node-cron only');
    return;
  }

  const dest = `${backendUrl}/api/companies/refresh-all`;
  const qstash = new Client({ token });
  const existing = await qstash.schedules.list();

  if (existing.some((s: { destination: string }) => s.destination === dest)) return;

  // Tuesday 12:00 IST = Tuesday 06:30 UTC
  await qstash.schedules.create({ destination: dest, cron: '30 6 * * 2' });
  console.log('[refresh] QStash weekly refresh schedule registered → Tuesday 12:00 IST');
}
