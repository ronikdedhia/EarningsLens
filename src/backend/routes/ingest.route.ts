import { Router, Request, Response } from 'express';
import { enqueueOrRunIngestion, runIngestion, type IngestBody } from '../services/ingestion.service';
import { qstashVerify } from '../middleware/qstash';

const router = Router();

function missingFields(body: Partial<IngestBody>): boolean {
  return !body.ticker || !body.quarter || !body.fiscalYear || !body.transcript;
}

// POST /api/ingest — signed-in users only (see middleware/auth.ts)
router.post('/', async (req: Request, res: Response) => {
  if (missingFields(req.body)) {
    return res.status(400).json({ error: 'ticker, quarter, fiscalYear, and transcript are required' });
  }
  try {
    const result = await enqueueOrRunIngestion(req.body as IngestBody);
    return res.status(result.queued ? 202 : 200).json(result);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/ingest/worker — called by QStash after queuing. Previously unauthenticated,
// so anyone could post a transcript straight into the pipeline.
router.post('/worker', qstashVerify, async (req: Request, res: Response) => {
  if (missingFields(req.body)) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const result = await runIngestion(req.body as IngestBody);
    return res.json(result);
  } catch (err) {
    // 5xx makes QStash retry the delivery
    return res.status(500).json({ error: (err as Error).message });
  }
});

export { router as ingestRouter };
