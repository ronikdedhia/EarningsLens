import { Router, Request, Response } from 'express';
import { getRedFlags, getRecentRedFlags } from '../services/turso.service';
import { scanAndSaveRedFlags } from '../services/redflags.service';

const router = Router();

// GET /api/redflags?ticker=HDFCBANK[&quarter=Q3FY25]
router.get('/', async (req: Request, res: Response) => {
  const { ticker, quarter } = req.query as { ticker?: string; quarter?: string };
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const flags = await getRedFlags(ticker.toUpperCase(), quarter);
  return res.json({ flags });
});

// GET /api/redflags/feed?days=7
router.get('/feed', async (req: Request, res: Response) => {
  const days = Math.min(30, Math.max(1, Number(req.query.days ?? 7)));
  const flags = await getRecentRedFlags(days, 50);
  return res.json({ flags });
});

// POST /api/redflags/scan  { ticker, quarter }
router.post('/scan', async (req: Request, res: Response) => {
  const { ticker, quarter } = req.body;
  if (!ticker || !quarter) return res.status(400).json({ error: 'ticker and quarter required' });

  const flags = await scanAndSaveRedFlags(ticker.toUpperCase(), quarter);
  return res.json({ flags, found: flags.length });
});

export { router as redflagsRouter };
