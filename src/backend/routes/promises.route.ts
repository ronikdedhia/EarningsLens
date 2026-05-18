import { Router, Request, Response } from 'express';
import { getPromises } from '../services/turso.service';
import { extractPromisesForQuarter, resolvePromisesForQuarter } from '../services/promises.service';

const router = Router();

// GET /api/promises?ticker=HDFCBANK[&quarter=Q3FY25]
router.get('/', async (req: Request, res: Response) => {
  const { ticker, quarter } = req.query as { ticker?: string; quarter?: string };
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const rows = await getPromises(ticker.toUpperCase(), quarter);
  return res.json({ promises: rows });
});

// POST /api/promises/extract  { ticker, quarter }
router.post('/extract', async (req: Request, res: Response) => {
  const { ticker, quarter } = req.body;
  if (!ticker || !quarter) return res.status(400).json({ error: 'ticker and quarter required' });

  const promises = await extractPromisesForQuarter(ticker.toUpperCase(), quarter);
  return res.json({ promises, extracted: promises.length });
});

// POST /api/promises/resolve  { ticker, quarter }  — check pending promises against new quarter
router.post('/resolve', async (req: Request, res: Response) => {
  const { ticker, quarter } = req.body;
  if (!ticker || !quarter) return res.status(400).json({ error: 'ticker and quarter required' });

  const { resolved } = await resolvePromisesForQuarter(ticker.toUpperCase(), quarter);
  return res.json({ resolved });
});

export { router as promisesRouter };
