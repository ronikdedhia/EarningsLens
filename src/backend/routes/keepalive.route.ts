import { Router } from 'express';
import { Client } from '@upstash/qstash';
import { QdrantClient } from '@qdrant/js-client-rest';
import { notify } from '../services/telegram.service';

export const keepaliveRouter = Router();

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

export async function registerKeepaliveSchedule() {
  const token = process.env.QSTASH_TOKEN;
  const backendUrl = process.env.BACKEND_PUBLIC_URL;
  if (!token || !backendUrl) return;

  const destination = `${backendUrl}/api/keepalive/ping`;
  const qstash = new Client({ token });

  const existing = await qstash.schedules.list();
  const alreadyRegistered = existing.some((s: { destination: string }) => s.destination === destination);
  if (alreadyRegistered) return;

  await qstash.schedules.create({
    destination,
    cron: '*/14 * * * *', // every 14 min — keeps Render free tier awake
  });
  console.log('[keepalive] QStash schedule registered →', destination);
}
