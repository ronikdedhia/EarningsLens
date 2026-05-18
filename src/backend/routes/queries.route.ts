import { Router, Request, Response } from 'express';
import { embedText } from '../services/embedding.service';
import { searchChunks, type ChunkPayload } from '../services/qdrant.service';
import { rateQuery } from '../services/turso.service';

const router = Router();

// GET /api/queries/keyword?q=credit+cost&ticker=HDFCBANK&topK=50
// Vector-search only — no LLM. Returns mention frequency per quarter for charting.
router.get('/keyword', async (req: Request, res: Response) => {
  const q      = (req.query.q as string)?.trim();
  const ticker = req.query.ticker as string | undefined;
  const topK   = Math.min(parseInt(req.query.topK as string) || 50, 100);

  if (!q) return res.status(400).json({ error: 'q is required' });

  const vector  = await embedText(q);
  const results = await searchChunks(vector, { ticker: ticker?.toUpperCase() }, topK);

  const quarterMap = new Map<string, { count: number; samples: object[] }>();

  for (const r of results) {
    const p   = r.payload as unknown as ChunkPayload;
    const key = `${p.ticker}::${p.quarter}`;
    if (!quarterMap.has(key)) quarterMap.set(key, { count: 0, samples: [] });
    const entry = quarterMap.get(key)!;
    entry.count++;
    if (entry.samples.length < 3) {
      entry.samples.push({
        ticker:  p.ticker,
        quarter: p.quarter,
        speaker: `${p.speakerRole} ${p.speakerName}`,
        text:    p.text,
        score:   r.score,
      });
    }
  }

  const data = Array.from(quarterMap.entries())
    .map(([key, v]) => {
      const [tkr, quarter] = key.split('::');
      return { ticker: tkr, quarter, ...v };
    })
    .sort((a, b) => a.quarter.localeCompare(b.quarter) || a.ticker.localeCompare(b.ticker));

  return res.json({ query: q, ticker: ticker?.toUpperCase() ?? null, total: results.length, data });
});

// POST /api/queries/:id/rate  — body: { rating: 1 | -1 }
router.post('/:id/rate', async (req: Request, res: Response) => {
  const id     = parseInt(req.params.id);
  const { rating } = req.body;

  if (!id || ![-1, 1].includes(rating)) {
    return res.status(400).json({ error: 'id and rating (1 or -1) required' });
  }

  await rateQuery(id, rating as 1 | -1);
  return res.json({ ok: true });
});

export { router as queriesRouter };
