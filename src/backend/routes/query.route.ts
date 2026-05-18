import { Router, Request, Response } from 'express';
import { runRAGQuery } from '../rag/chain';
import { saveQueryLog } from '../services/turso.service';
import { upsertQueryLog } from '../services/qdrant.service';
import { notify } from '../services/telegram.service';
import { sendEmail, queryEmail } from '../services/email.service';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const { query, ticker, quarters, speakerRole, beforeDate, topK } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  const { queryVector, ...result } = await runRAGQuery(query.trim(), {
    ticker, quarters, speakerRole, beforeDate, topK,
  });

  // Await Turso to get the ID (fast write, <50ms); Qdrant is fire-and-forget
  let queryLogId: number | undefined;
  try {
    queryLogId = await saveQueryLog({ query: query.trim(), answer: result.answer, ticker, quarters });
  } catch {}

  upsertQueryLog(queryVector, {
    query: query.trim(), answer: result.answer, ticker, quarters,
    createdAt: new Date().toISOString(),
  }).catch(() => {});

  notify(`🔎 *Query*${ticker ? ` — *${String(ticker).toUpperCase()}*` : ''}\n\`${query.trim().slice(0, 120)}\``);
  const { subject, html } = queryEmail(query.trim(), result.answer, ticker ? String(ticker).toUpperCase() : undefined);
  sendEmail(subject, html).catch(() => {});

  return res.json({ ...result, queryLogId });
});

export { router as queryRouter };
