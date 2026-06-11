import { Router, Request, Response } from 'express';
import { Client } from '@upstash/qstash';
import { ingestGraph } from '../graphs/ingest.graph';
import { notify } from '../services/telegram.service';

const router = Router();

interface IngestBody {
  ticker:      string;
  quarter:     string;
  fiscalYear:  number;
  publishedAt?: string;
  source?:     string;
  transcript:  string;
}

async function runIngestion(body: IngestBody) {
  const state = await ingestGraph.invoke({
    ticker:      body.ticker,
    quarter:     body.quarter,
    fiscalYear:  body.fiscalYear,
    publishedAt: body.publishedAt ?? '',
    source:      body.source ?? '',
    transcript:  body.transcript,
    skipped:     false,
    points:      [],
    turns:       0,
    result:      { message: '' },
  });
  return state.result;
}

// POST /api/ingest — enqueue via QStash if configured, else process synchronously
router.post('/', async (req: Request, res: Response) => {
  const { ticker, quarter, fiscalYear, transcript } = req.body;

  if (!ticker || !quarter || !fiscalYear || !transcript) {
    return res.status(400).json({ error: 'ticker, quarter, fiscalYear, and transcript are required' });
  }

  if (process.env.QSTASH_TOKEN && process.env.BACKEND_PUBLIC_URL) {
    const qstash = new Client({ token: process.env.QSTASH_TOKEN });
    await qstash.publishJSON({
      url:  `${process.env.BACKEND_PUBLIC_URL}/api/ingest/worker`,
      body: req.body,
    });
    notify(`⏳ *${String(ticker).toUpperCase()} ${quarter}* queued for ingestion`);
    return res.status(202).json({
      message: `${String(ticker).toUpperCase()} ${quarter} queued — processing in background`,
      queued:  true,
    });
  }

  const result = await runIngestion(req.body as IngestBody);
  return res.json(result);
});

// POST /api/ingest/worker — called by QStash after queuing
router.post('/worker', async (req: Request, res: Response) => {
  const { ticker, quarter, fiscalYear, transcript } = req.body;

  if (!ticker || !quarter || !fiscalYear || !transcript) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const result = await runIngestion(req.body as IngestBody);
  return res.json(result);
});

export { router as ingestRouter };
