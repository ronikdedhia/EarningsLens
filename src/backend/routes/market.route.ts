import { Router, Request, Response } from 'express';
import { qstashVerify } from '../middleware/qstash';
import { listReactions, listFinancials, listSignals, listBoardMeetings, type EventType } from '../services/market-store.service';
import { summarize } from '../services/reactions.service';
import { buildQuarterViews, relevantPromises } from '../services/financials.service';
import { getPromises } from '../services/turso.service';
import { istDate, addDays } from '../services/nse.service';
import { runEveningJobs } from '../services/jobs.service';
import { getValuation } from '../services/valuation.service';
import { listShareholding, compareHoldings } from '../services/shareholding.service';
import { listFdaEvents, listOrders, orderSummary, FDA_LABELS, isBadFda } from '../services/corporate-events.service';

const router = Router();

const ticker = (req: Request) => (req.query.ticker as string | undefined)?.trim().toUpperCase() || undefined;
const EVENT_TYPES = new Set(['filing', 'red_flag', 'signal', 'fda']);

// GET /api/market/reactions/summary[?ticker=X] — average move after each kind of event
router.get('/reactions/summary', async (req: Request, res: Response) => {
  const rows = await listReactions({ ticker: ticker(req) });
  return res.json({ buckets: summarize(rows), events: rows.length });
});

// GET /api/market/reactions?ticker=X[&type=filing|red_flag|signal]
router.get('/reactions', async (req: Request, res: Response) => {
  const type = req.query.type as string | undefined;
  if (type && !EVENT_TYPES.has(type)) return res.status(400).json({ error: 'type must be filing, red_flag or signal' });
  const rows = await listReactions({ ticker: ticker(req), eventType: type as EventType | undefined });
  return res.json({ reactions: rows.slice(0, 500) });
});

// GET /api/market/financials?ticker=X — quarters with QoQ/YoY and the numeric promises to read them against
router.get('/financials', async (req: Request, res: Response) => {
  const t = ticker(req);
  if (!t) return res.status(400).json({ error: 'ticker required' });
  const [rows, promises] = await Promise.all([listFinancials(t), getPromises(t)]);
  const quarters = buildQuarterViews(rows).map(v => ({
    ...v,
    promises: relevantPromises(promises, v.row.quarter, 5),
  }));
  return res.json({ ticker: t, quarters });
});

// GET /api/market/signals?ticker=X&days=90
router.get('/signals', async (req: Request, res: Response) => {
  const days = Math.min(Math.max(parseInt(req.query.days as string) || 90, 1), 730);
  const signals = await listSignals({ ticker: ticker(req), sinceIso: addDays(istDate(new Date()), -days), limit: 300 });
  return res.json({ signals });
});

// GET /api/market/calendar — results board meetings in the next 45 days
router.get('/calendar', async (_req: Request, res: Response) => {
  const today = istDate(new Date());
  return res.json({ meetings: await listBoardMeetings(today, addDays(today, 45)) });
});

// GET /api/market/valuation?ticker=X — market cap, P/E and EV/EBITDA vs 2-year range
router.get('/valuation', async (req: Request, res: Response) => {
  const t = ticker(req);
  if (!t) return res.status(400).json({ error: 'ticker required' });
  return res.json(await getValuation(t));
});

// GET /api/market/shareholding?ticker=X — quarters with changes and flags
router.get('/shareholding', async (req: Request, res: Response) => {
  const t = ticker(req);
  if (!t) return res.status(400).json({ error: 'ticker required' });
  const rows = await listShareholding(t);
  const quarters = rows.map((r, i) => ({ ...r, flags: compareHoldings(rows[i - 1] ?? null, r) }));
  return res.json({ ticker: t, quarters });
});

// GET /api/market/fda?ticker=X&days=365
router.get('/fda', async (req: Request, res: Response) => {
  const days = Math.min(Math.max(parseInt(req.query.days as string) || 365, 1), 1500);
  const events = await listFdaEvents({ ticker: ticker(req), sinceIso: addDays(istDate(new Date()), -days), limit: 300 });
  return res.json({ events: events.map(e => ({ ...e, label: FDA_LABELS[e.eventType], bad: isBadFda(e.eventType) })) });
});

// GET /api/market/orders?ticker=X — order wins and 12-month inflow vs TTM revenue
router.get('/orders', async (req: Request, res: Response) => {
  const t = ticker(req);
  if (!t) return res.status(400).json({ error: 'ticker required' });
  const [orders, summary] = await Promise.all([listOrders(t), orderSummary(t)]);
  return res.json({ ticker: t, summary, orders });
});

// POST /api/market/briefs/run — QStash, 19:00 IST
router.post('/briefs/run', qstashVerify, async (_req: Request, res: Response) => {
  res.status(202).json({ status: 'started' });
  runEveningJobs().catch(err => console.error('[briefs] failed:', err));
});

export { router as marketRouter };
