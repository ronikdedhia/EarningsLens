import { Router, Request, Response } from 'express';
import { getDailyFilings, getLatestFilingDate } from '../services/turso.service';
import { runDailyFilingsScrape } from '../graphs/daily-filings.graph';

const router = Router();

// GET /api/daily-filings?date=YYYY-MM-DD&ticker=HDFCBANK&importantOnly=true
router.get('/', async (req: Request, res: Response) => {
  const {
    date,
    ticker,
    importantOnly,
    limit = '100',
  } = req.query as Record<string, string>;

  const filings = await getDailyFilings({
    date:          date || undefined,
    ticker:        ticker || undefined,
    importantOnly: importantOnly === 'true',
    limit:         Math.min(parseInt(limit) || 100, 200),
  });

  return res.json({ filings, count: filings.length });
});

// GET /api/daily-filings/latest-date — last date with any filings
router.get('/latest-date', async (_req: Request, res: Response) => {
  const date = await getLatestFilingDate();
  return res.json({ date });
});

// POST /api/daily-filings/run — manually trigger today's scrape (admin use)
router.post('/run', async (req: Request, res: Response) => {
  const { date } = req.body as { date?: string };
  const result = await runDailyFilingsScrape(date);
  return res.json({ ...result, message: `Scraped ${result.saved} filings (${result.important} important)` });
});

export { router as dailyFilingsRouter };
