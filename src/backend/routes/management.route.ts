import { Router, Request, Response } from 'express';
import { getManagementScores, getIngestedQuarters } from '../services/turso.service';
import { analyzeManagementForTicker } from '../services/management.service';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const ticker = (req.query.ticker as string | undefined)?.toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const scores = await getManagementScores(ticker);
  return res.json({ ticker, scores });
});

router.post('/analyze', async (req: Request, res: Response) => {
  const { ticker, quarters } = req.body as { ticker?: string; quarters?: string[] };
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const T  = ticker.toUpperCase();
  const qs = quarters?.length ? quarters : await getIngestedQuarters(T);
  if (!qs.length) return res.status(404).json({ error: 'No ingested quarters found for this ticker' });
  try {
    const scores = await analyzeManagementForTicker(T, qs);
    return res.json({ ticker: T, scores });
  } catch (err: unknown) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Analysis failed' });
  }
});

export { router as managementRouter };
