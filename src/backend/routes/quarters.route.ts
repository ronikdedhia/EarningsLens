import { Router, Request, Response } from 'express';
import { registerQuarter, getPendingIngestions } from '../services/turso.service';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const pending = await getPendingIngestions();
  return res.json({ pending, count: pending.length });
});

router.post('/', async (req: Request, res: Response) => {
  const { ticker, quarter, fiscalYear, publishedAt, pdfUrl } = req.body;

  if (!ticker || !quarter || !fiscalYear || !pdfUrl) {
    return res.status(400).json({ error: 'ticker, quarter, fiscalYear, and pdfUrl are required' });
  }

  await registerQuarter({
    ticker: ticker.toUpperCase(),
    quarter,
    fiscalYear,
    publishedAt,
    pdfUrl,
  });

  return res.json({ message: `${ticker.toUpperCase()} ${quarter} registered for ingestion` });
});

export { router as quartersRouter };
