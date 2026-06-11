import { Router, Request, Response } from 'express';
import { getDailyFilings, getLatestFilingDate } from '../services/turso.service';
import { runDailyFilingsScrape } from '../graphs/daily-filings.graph';
import { qstashVerify } from '../middleware/qstash';

const router = Router();

// ── Scrape status tracker ─────────────────────────────────────────────────────

type ScrapeStatus = {
  running:    boolean;
  startedAt:  string | null;
  finishedAt: string | null;
  stage:      string;
  progress:   string[];   // rolling log of steps
  result:     { saved: number; important: number } | null;
  error:      string | null;
};

const status: ScrapeStatus = {
  running:    false,
  startedAt:  null,
  finishedAt: null,
  stage:      'idle',
  progress:   [],
  result:     null,
  error:      null,
};

export function updateScrapeStage(stage: string, detail?: string) {
  status.stage = stage;
  const line = detail ? `${stage}: ${detail}` : stage;
  status.progress.push(`[${new Date().toISOString()}] ${line}`);
  console.log(`[scrape-status] ${line}`);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/daily-filings?date=YYYY-MM-DD&ticker=HDFCBANK&importantOnly=true
router.get('/', async (req: Request, res: Response) => {
  try {
    const { date, ticker, importantOnly, limit = '100' } = req.query as Record<string, string>;
    const filings = await getDailyFilings({
      date:          date || undefined,
      ticker:        ticker || undefined,
      importantOnly: importantOnly === 'true',
      limit:         Math.min(parseInt(limit) || 100, 200),
    });
    return res.json({ filings, count: filings.length });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/daily-filings/latest-date
router.get('/latest-date', async (_req: Request, res: Response) => {
  try {
    const date = await getLatestFilingDate();
    return res.json({ date });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/daily-filings/status — live scrape progress
router.get('/status', (_req: Request, res: Response) => {
  res.json(status);
});

// POST /api/daily-filings/run — fire-and-forget, poll /status for progress
router.post('/run', qstashVerify, (req: Request, res: Response) => {
  if (status.running) {
    return res.status(409).json({ error: 'Scrape already in progress', status });
  }

  const { date } = (req.body as { date?: string }) ?? {};

  // Reset status
  status.running    = true;
  status.startedAt  = new Date().toISOString();
  status.finishedAt = null;
  status.stage      = 'started';
  status.progress   = [`[${status.startedAt}] started date=${date ?? 'today'}`];
  status.result     = null;
  status.error      = null;

  // Respond immediately — client polls /status
  res.json({ status: 'started', message: 'Scrape kicked off. Poll GET /api/daily-filings/status for progress.' });

  // Run in background
  const TIMEOUT_MS = 10 * 60 * 1000;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('scrape timed out after 10 min')), TIMEOUT_MS)
  );

  Promise.race([runDailyFilingsScrape(date), timeout])
    .then(result => {
      status.running    = false;
      status.finishedAt = new Date().toISOString();
      status.stage      = 'done';
      status.result     = result;
      status.progress.push(`[${status.finishedAt}] DONE — saved=${result.saved} important=${result.important}`);
      console.log('[daily-filings/run] DONE', result);
    })
    .catch(err => {
      status.running    = false;
      status.finishedAt = new Date().toISOString();
      status.stage      = 'error';
      status.error      = String(err);
      status.progress.push(`[${status.finishedAt}] ERROR — ${String(err)}`);
      console.error('[daily-filings/run] ERROR', err);
    });
});

export { router as dailyFilingsRouter };
