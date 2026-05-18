import { Router, Request, Response } from 'express';
import { getSentimentHistory } from '../services/turso.service';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const ticker = req.query.ticker as string;
  const topic  = req.query.topic as string | undefined;

  if (!ticker) return res.status(400).json({ error: 'ticker query param required' });

  const history = await getSentimentHistory(ticker.toUpperCase(), topic);
  return res.json({ ticker: ticker.toUpperCase(), topic: topic ?? null, history });
});

export { router as sentimentRouter };
