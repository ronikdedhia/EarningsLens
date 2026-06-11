import { Router } from 'express';
import { Client } from '@upstash/qstash';
import { QdrantClient } from '@qdrant/js-client-rest';
import { notify } from '../services/telegram.service';
import { qstashVerify } from '../middleware/qstash';
import { sendWeeklyNewsletter, parseNewsletterCron } from '../services/newsletter.service';

export const keepaliveRouter = Router();

// Lazy import to avoid circular dep — server.ts exports sendDailyReport
let _sendDailyReport: (() => Promise<void>) | null = null;
export function setDailyReportHandler(fn: () => Promise<void>) { _sendDailyReport = fn; }

keepaliveRouter.post('/daily-report', qstashVerify, async (_, res) => {
  if (_sendDailyReport) await _sendDailyReport();
  res.json({ status: 'ok' });
});

keepaliveRouter.post('/newsletter', qstashVerify, async (_, res) => {
  try {
    const result = await sendWeeklyNewsletter();
    console.log('[newsletter]', result);
    res.json(result);
  } catch (err) {
    console.error('[newsletter] ERROR', err);
    notify(`⚠️ *EarningsLens* weekly newsletter failed: \`${String(err).slice(0, 200)}\``);
    res.status(500).json({ error: String(err) });
  }
});

keepaliveRouter.post('/test-telegram', async (_, res) => {
  const token  = process.env.TELEGRAM_ACCESS_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return res.status(500).json({ error: 'TELEGRAM_ACCESS_TOKEN or TELEGRAM_CHAT_ID not set in env' });
  }
  notify('🧪 *EarningsLens* — Telegram test message. If you see this, the integration is working!');
  return res.json({ status: 'sent', chatId });
});

keepaliveRouter.post('/ping', qstashVerify, async (_, res) => {
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

export async function pingQdrantOnce() {
  try {
    await pingQdrant();
  } catch (err) {
    console.error('[keepalive] Qdrant ping failed:', err);
  }
}

export async function registerKeepaliveSchedule() {
  console.log('[keepalive] Qdrant will be pinged once daily alongside the daily report');

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

export async function registerNewsletterSchedule() {
  const token = process.env.QSTASH_TOKEN;
  const backendUrl = process.env.BACKEND_PUBLIC_URL;
  if (!token || !backendUrl) {
    console.log('[newsletter] QSTASH_TOKEN or BACKEND_PUBLIC_URL not set — relying on node-cron only');
    return;
  }

  const dest = `${backendUrl}/api/keepalive/newsletter`;
  const qstash = new Client({ token });
  const existing = await qstash.schedules.list();

  if (existing.some((s: { destination: string }) => s.destination === dest)) return;

  const cronExpr = parseNewsletterCron();
  await qstash.schedules.create({ destination: dest, cron: cronExpr });
  console.log(`[newsletter] QStash schedule registered → ${process.env.NEWSLETTER_SEND_TIME ?? '09:00'} IST Friday (${cronExpr} UTC)`);
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

  // Friday 12:00 IST = Friday 06:30 UTC
  await qstash.schedules.create({ destination: dest, cron: '30 6 * * 5' });
  console.log('[refresh] QStash weekly refresh schedule registered → Friday 12:00 IST');
}
