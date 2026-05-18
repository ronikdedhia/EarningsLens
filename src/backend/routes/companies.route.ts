import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router, Request, Response } from 'express';
import { listCompaniesWithStatus, getSystemStats, registerQuarter, isQuarterIngested, addCompany, getCompany, getUserCompanyCount, isUserPremium, trackUserCompany } from '../services/turso.service';
import { discoverPdfUrl } from '../services/bse.service';
import { getCompanyInfoFromScreener, searchCompanies } from '../services/screener.service';
import { getLastNQuarters } from '../utils/quarters';
import { notify } from '../services/telegram.service';
import { sendEmail, discoveryEmail } from '../services/email.service';

const execFileAsync = promisify(execFile);
const router = Router();

// BSE AttachLive URLs expire quickly — download via curl immediately while URL is fresh
async function fetchPdfText(url: string): Promise<string> {
  const { stdout } = await execFileAsync('curl', [
    '-sL', url,
    '-H', 'Referer: https://www.bseindia.com/',
    '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--max-time', '30',
    '--output', '-',
  ], { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 });

  if (stdout.slice(0, 4).toString() !== '%PDF') {
    throw new Error(`Not a PDF (got HTML — URL expired or blocked)`);
  }

  const pdfParse = (await import('pdf-parse')).default;
  const { text } = await pdfParse(stdout);
  return text;
}

// GET /api/companies — all companies with per-quarter ingestion status + system stats
router.get('/', async (_req: Request, res: Response) => {
  const [companies, stats] = await Promise.all([
    listCompaniesWithStatus(),
    getSystemStats(),
  ]);
  return res.json({ companies, stats });
});

// GET /api/companies/search?q=... — search Screener.in for matching companies
router.get('/search', async (req: Request, res: Response) => {
  const q = (req.query.q as string ?? '').trim();
  if (!q) return res.json([]);
  try {
    const results = await searchCompanies(q);
    return res.json(results);
  } catch (err) {
    return res.status(502).json({ error: `Company search failed: ${(err as Error).message}` });
  }
});

// GET /api/companies/:ticker — look up company info without creating anything
router.get('/:ticker', async (req: Request, res: Response) => {
  const t = req.params.ticker.toUpperCase();

  const existing = await getCompany(t);
  if (existing) return res.json({ ticker: t, name: existing.name, sector: existing.sector, bseCode: existing.bseCode, exists: true });

  const info = await getCompanyInfoFromScreener(t);
  if (!info) return res.status(404).json({ error: `Could not find company info for "${t}". Check the NSE ticker and try again.` });

  return res.json({ ticker: t, name: info.name, sector: info.sector, bseCode: null, exists: false });
});

// POST /api/companies — register a new company in the DB
router.post('/', async (req: Request, res: Response) => {
  const { ticker, name, sector, bseCode } = req.body as { ticker?: string; name?: string; sector?: string; bseCode?: string };

  if (!ticker?.trim() || !name?.trim() || !sector?.trim()) {
    return res.status(400).json({ error: 'ticker, name, and sector are required' });
  }

  const t = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9&-]{1,20}$/.test(t)) {
    return res.status(400).json({ error: 'Invalid ticker format' });
  }

  const created = await addCompany(t, name.trim(), sector.trim(), bseCode?.trim() || undefined);
  return res.json({ ticker: t, created });
});

const FREE_COMPANY_LIMIT = 2;

// POST /api/companies/add-and-discover — single-step: look up name → create → discover
router.post('/add-and-discover', async (req: Request, res: Response) => {
  const { ticker, userId } = req.body as { ticker?: string; userId?: string };
  if (!ticker?.trim()) return res.status(400).json({ error: 'ticker is required' });

  const t = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9&-]{1,20}$/.test(t)) return res.status(400).json({ error: 'Invalid ticker format' });

  // Per-user company limit for free accounts
  if (userId) {
    const [count, premium] = await Promise.all([
      getUserCompanyCount(userId),
      isUserPremium(userId),
    ]);
    if (!premium && count >= FREE_COMPANY_LIMIT) {
      return res.status(402).json({
        error: `Free accounts can track up to ${FREE_COMPANY_LIMIT} companies. Upgrade to Premium for unlimited coverage.`,
        limitReached: true,
        count,
        limit: FREE_COMPANY_LIMIT,
      });
    }
  }

  // Block if already in DB
  const existing = await getCompany(t);
  if (existing) return res.status(409).json({ error: `${t} is already added`, company: existing });

  // Look up company info from Screener.in
  const info = await getCompanyInfoFromScreener(t);
  const name   = info?.name   ?? t;
  const sector = info?.sector ?? 'Other';

  await addCompany(t, name, sector);

  // Record this company against the user
  if (userId) await trackUserCompany(userId, t);

  // Kick off discovery (reuse internal logic via self-request)
  const port = process.env.BACKEND_PORT ?? '3001';
  const discRes = await fetch(`http://localhost:${port}/api/companies/${t}/discover`, { method: 'POST' });
  const discData = await discRes.json() as { results?: unknown[] };

  return res.json({ ticker: t, name, sector, results: discData.results ?? [] });
});

// POST /api/companies/:ticker/discover
// Discovers BSE transcript PDFs and immediately ingests them — URLs expire quickly.
router.post('/:ticker/discover', async (req: Request, res: Response) => {
  const ticker   = req.params.ticker.toUpperCase();
  const n        = parseInt(req.query.quarters as string) || 4;
  const quarters = getLastNQuarters(n);
  const port     = process.env.BACKEND_PORT ?? '3001';

  const results: Array<{ quarter: string; pdfUrl: string | null; status: string }> = [];

  for (const q of quarters) {
    if (await isQuarterIngested(ticker, q.quarter)) {
      results.push({ quarter: q.quarter, pdfUrl: null, status: 'already_ingested' });
      continue;
    }

    let pdfUrl: string | null = null;
    try {
      pdfUrl = await discoverPdfUrl(ticker, q.quarter);
    } catch (err) {
      results.push({ quarter: q.quarter, pdfUrl: null, status: `error: ${(err as Error).message}` });
      continue;
    }

    if (!pdfUrl) {
      results.push({ quarter: q.quarter, pdfUrl: null, status: 'not_found' });
      continue;
    }

    // Register first so it's tracked even if ingest fails
    await registerQuarter({ ticker, quarter: q.quarter, fiscalYear: q.fiscalYear, publishedAt: q.publishedAt, pdfUrl });

    // Immediately download + ingest while URL is fresh
    try {
      const transcript = await fetchPdfText(pdfUrl);
      if (transcript.trim().length < 200) {
        results.push({ quarter: q.quarter, pdfUrl, status: 'queued (PDF too short — check URL)' });
        continue;
      }

      const ingestRes = await fetch(`http://localhost:${port}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, quarter: q.quarter, fiscalYear: q.fiscalYear, publishedAt: q.publishedAt, source: pdfUrl, transcript }),
      });
      const ingestData = await ingestRes.json() as { message?: string; skipped?: boolean; chunks?: number; error?: string };

      if (!ingestRes.ok) {
        results.push({ quarter: q.quarter, pdfUrl, status: `queued (ingest error: ${ingestData.error ?? ingestRes.status})` });
      } else if (ingestData.skipped) {
        results.push({ quarter: q.quarter, pdfUrl, status: 'already_ingested' });
      } else {
        results.push({ quarter: q.quarter, pdfUrl, status: `ingested (${ingestData.chunks} chunks)` });
      }
    } catch (err) {
      results.push({ quarter: q.quarter, pdfUrl, status: `queued (download failed: ${(err as Error).message})` });
    }
  }

  const ingested = results.filter(r => r.status.startsWith('ingested'));
  const queued   = results.filter(r => r.status.startsWith('queued'));

  if (ingested.length > 0 || queued.length > 0) {
    const qList = [...ingested, ...queued].map(r => r.quarter).join(', ');
    notify(`🔍 *${ticker}* — ${ingested.length} ingested · ${queued.length} queued\nQuarters: ${qList}`);
    const { subject, html } = discoveryEmail(ticker, ingested.length + queued.length, qList.split(', '));
    sendEmail(subject, html).catch(() => {});
  }

  return res.json({ ticker, results });
});

export { router as companiesRouter };
