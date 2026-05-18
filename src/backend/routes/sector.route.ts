import { Router, Request, Response } from 'express';
import {
  generateSectorNarrative,
  getSectorEvolution,
  listAvailableSectors,
} from '../services/sector.service';
import { getIngestedQuarters } from '../services/turso.service';
import { listCompanies } from '../services/turso.service';

const router = Router();

// GET /api/sector/sectors — list all available sectors
router.get('/sectors', async (_req: Request, res: Response) => {
  const sectors = await listAvailableSectors();
  return res.json({ sectors });
});

// GET /api/sector/quarters?sector=Banking — ingested quarters for a sector
router.get('/quarters', async (req: Request, res: Response) => {
  const { sector } = req.query as { sector?: string };
  if (!sector) return res.status(400).json({ error: 'sector required' });

  const allCompanies = await listCompanies();
  const tickers = allCompanies
    .filter(c => c.sector.toLowerCase() === sector.toLowerCase())
    .map(c => c.ticker);

  // Union of ingested quarters across all companies in sector
  const quarterSets = await Promise.all(tickers.map(t => getIngestedQuarters(t)));
  const allQuarters = [...new Set(quarterSets.flat())].sort().reverse();

  return res.json({ quarters: allQuarters });
});

// GET /api/sector?sector=Banking&quarter=Q3FY25 — get or generate narrative
router.get('/', async (req: Request, res: Response) => {
  const { sector, quarter, refresh } = req.query as {
    sector?: string; quarter?: string; refresh?: string;
  };
  if (!sector || !quarter) {
    return res.status(400).json({ error: 'sector and quarter required' });
  }

  const narrative = await generateSectorNarrative(
    sector,
    quarter,
    refresh === '1',
  );
  return res.json(narrative);
});

// GET /api/sector/evolution?sector=Banking — last 4 cached narratives
router.get('/evolution', async (req: Request, res: Response) => {
  const { sector } = req.query as { sector?: string };
  if (!sector) return res.status(400).json({ error: 'sector required' });

  const history = await getSectorEvolution(sector);
  return res.json({ history });
});

export { router as sectorRouter };
