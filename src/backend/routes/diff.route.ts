import { Router, Request, Response } from 'express';
import { computeDiff } from '../services/diff.service';
import { getIngestedQuarters } from '../services/turso.service';

const router = Router();

// GET /api/diff?ticker=HDFCBANK&q1=Q3FY25&q2=Q4FY25
router.get('/', async (req: Request, res: Response) => {
  const { ticker, q1, q2 } = req.query as { ticker?: string; q1?: string; q2?: string };
  if (!ticker || !q1 || !q2) {
    return res.status(400).json({ error: 'ticker, q1 and q2 required' });
  }
  if (q1 === q2) {
    return res.status(400).json({ error: 'q1 and q2 must be different quarters' });
  }

  const result = await computeDiff(ticker.toUpperCase(), q1, q2);
  return res.json(result);
});

// GET /api/diff/quarters?ticker=HDFCBANK  — available quarters for selector
router.get('/quarters', async (req: Request, res: Response) => {
  const { ticker } = req.query as { ticker?: string };
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const quarters = await getIngestedQuarters(ticker.toUpperCase());
  return res.json({ quarters });
});

export { router as diffRouter };
