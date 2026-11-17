import type { InStatement } from '@libsql/client';
import { db } from './turso.service';
import type { DailyBar } from './nse.service';

// Tables are created by scripts/init-db.ts.

// ── Price history ─────────────────────────────────────────────────────────────

export async function getPriceRange(ticker: string): Promise<{ min: string | null; max: string | null }> {
  const { rows } = await db().execute({
    sql: 'SELECT MIN(trade_date) AS mn, MAX(trade_date) AS mx FROM price_history WHERE ticker = ?',
    args: [ticker],
  });
  return { min: (rows[0]?.mn as string) ?? null, max: (rows[0]?.mx as string) ?? null };
}

export async function savePriceBars(ticker: string, bars: DailyBar[]): Promise<void> {
  for (let i = 0; i < bars.length; i += 200) {
    const stmts: InStatement[] = bars.slice(i, i + 200).map(b => ({
      sql: `INSERT INTO price_history (ticker, trade_date, close, prev_close) VALUES (?, ?, ?, ?)
            ON CONFLICT (ticker, trade_date) DO UPDATE SET close = excluded.close, prev_close = excluded.prev_close`,
      args: [ticker, b.date, b.close, b.prevClose],
    }));
    await db().batch(stmts, 'write');
  }
}

export async function getPriceBars(ticker: string, fromIso: string): Promise<DailyBar[]> {
  const { rows } = await db().execute({
    sql: `SELECT trade_date AS date, close, prev_close AS prevClose FROM price_history
          WHERE ticker = ? AND trade_date >= ? ORDER BY trade_date`,
    args: [ticker, fromIso],
  });
  return rows.map(r => ({ date: r.date as string, close: Number(r.close), prevClose: Number(r.prevClose) }));
}

// ── Events that need a price reaction ─────────────────────────────────────────

export type EventType = 'filing' | 'red_flag' | 'signal' | 'fda';

export interface MarketEvent {
  type:     EventType;
  id:       number;
  ticker:   string;
  date:     string;          // YYYY-MM-DD the event became public
  minutes:  number | null;   // IST time of day, null when unknown
  label:    string;          // filing importance, red flag severity, signal type:direction
  category: string;          // filing category, red flag type, insider category
}

function splitTimestamp(ts: unknown): { date: string; minutes: number | null } | null {
  const m = String(ts ?? '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return { date: m[1], minutes: m[2] ? +m[2] * 60 + +m[3] : null };
}

/** Events since `sinceIso` that don't yet have a complete (20-day) reaction. */
export async function listEventsNeedingReaction(sinceIso: string): Promise<MarketEvent[]> {
  const done = `SELECT event_id FROM price_reactions WHERE event_type = ? AND complete = 1`;
  const [filings, flags, signals, fda] = await Promise.all([
    db().execute({
      sql: `SELECT id, ticker, filing_date, filed_at, importance, filing_cat FROM daily_filings
            WHERE filing_date >= ? AND id NOT IN (${done})`,
      args: [sinceIso, 'filing'],
    }),
    db().execute({
      sql: `SELECT rf.id, rf.ticker, rf.severity, rf.flag_type, qi.transcript_filed_at
            FROM red_flags rf JOIN quarter_index qi ON qi.ticker = rf.ticker AND qi.quarter = rf.quarter
            WHERE qi.transcript_filed_at IS NOT NULL AND qi.transcript_filed_at >= ?
              AND rf.id NOT IN (${done})`,
      args: [sinceIso, 'red_flag'],
    }),
    db().execute({
      // Pledge snapshots carry no disclosure time, so they're excluded.
      sql: `SELECT id, ticker, event_date, event_minutes, signal_type, direction, category FROM market_signals
            WHERE event_date >= ? AND signal_type != 'pledge' AND id NOT IN (${done})`,
      args: [sinceIso, 'signal'],
    }),
    db().execute({
      sql: `SELECT id, ticker, event_date, event_minutes, event_type, source FROM fda_events
            WHERE event_date >= ? AND id NOT IN (${done})`,
      args: [sinceIso, 'fda'],
    }).catch(() => ({ rows: [] as Array<Record<string, unknown>> })),   // table absent before db:init
  ]);

  const events: MarketEvent[] = [];
  for (const r of filings.rows) {
    const ts = splitTimestamp(r.filed_at);
    events.push({
      type: 'filing', id: Number(r.id), ticker: String(r.ticker),
      date: ts?.date ?? String(r.filing_date), minutes: ts?.minutes ?? null,
      label: String(r.importance), category: String(r.filing_cat ?? ''),
    });
  }
  for (const r of flags.rows) {
    const ts = splitTimestamp(r.transcript_filed_at);
    if (!ts) continue;
    events.push({
      type: 'red_flag', id: Number(r.id), ticker: String(r.ticker), date: ts.date, minutes: ts.minutes,
      label: String(r.severity), category: String(r.flag_type),
    });
  }
  for (const r of signals.rows) {
    events.push({
      type: 'signal', id: Number(r.id), ticker: String(r.ticker), date: String(r.event_date),
      minutes: r.event_minutes == null ? null : Number(r.event_minutes),
      label: `${r.signal_type}:${r.direction}`, category: String(r.category ?? ''),
    });
  }
  for (const r of fda.rows) {
    events.push({
      type: 'fda', id: Number(r.id), ticker: String(r.ticker), date: String(r.event_date),
      minutes: r.event_minutes == null ? null : Number(r.event_minutes),
      label: String(r.event_type), category: String(r.source ?? ''),
    });
  }
  return events;
}

export interface ReactionRow {
  eventType: EventType;
  eventId:   number;
  ticker:    string;
  eventDate: string;
  label:     string;
  category:  string;
  baseDate:  string | null;
  ret1: number | null; ret5: number | null; ret20: number | null;
  nifty1: number | null; nifty5: number | null; nifty20: number | null;
  complete:  boolean;
}

export async function upsertReaction(r: ReactionRow): Promise<void> {
  await db().execute({
    sql: `INSERT INTO price_reactions
            (event_type, event_id, ticker, event_date, label, category, base_date,
             ret_1d, ret_5d, ret_20d, nifty_1d, nifty_5d, nifty_20d, complete, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT (event_type, event_id) DO UPDATE SET
            label = excluded.label, category = excluded.category, base_date = excluded.base_date,
            ret_1d = excluded.ret_1d, ret_5d = excluded.ret_5d, ret_20d = excluded.ret_20d,
            nifty_1d = excluded.nifty_1d, nifty_5d = excluded.nifty_5d, nifty_20d = excluded.nifty_20d,
            complete = excluded.complete, updated_at = excluded.updated_at`,
    args: [
      r.eventType, r.eventId, r.ticker, r.eventDate, r.label, r.category, r.baseDate,
      r.ret1, r.ret5, r.ret20, r.nifty1, r.nifty5, r.nifty20, r.complete ? 1 : 0,
    ],
  });
}

export async function listReactions(opts: { ticker?: string; eventType?: EventType } = {}): Promise<ReactionRow[]> {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.ticker)    { where.push('ticker = ?');     args.push(opts.ticker); }
  if (opts.eventType) { where.push('event_type = ?'); args.push(opts.eventType); }
  const { rows } = await db().execute({
    sql: `SELECT event_type, event_id, ticker, event_date, label, category, base_date,
                 ret_1d, ret_5d, ret_20d, nifty_1d, nifty_5d, nifty_20d, complete
          FROM price_reactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY event_date DESC LIMIT 5000`,
    args,
  });
  const n = (v: unknown) => (v == null ? null : Number(v));
  return rows.map(r => ({
    eventType: r.event_type as EventType, eventId: Number(r.event_id), ticker: String(r.ticker),
    eventDate: String(r.event_date), label: String(r.label), category: String(r.category ?? ''),
    baseDate: (r.base_date as string) ?? null,
    ret1: n(r.ret_1d), ret5: n(r.ret_5d), ret20: n(r.ret_20d),
    nifty1: n(r.nifty_1d), nifty5: n(r.nifty_5d), nifty20: n(r.nifty_20d),
    complete: r.complete === 1,
  }));
}

// ── Quarterly financials ──────────────────────────────────────────────────────

export interface FinancialRow {
  ticker:       string;
  quarter:      string;
  periodEnd:    string;
  basis:        'Consolidated' | 'Standalone';
  revenue:      number | null;
  otherIncome:  number | null;
  financeCosts: number | null;
  depreciation: number | null;
  exceptional:  number | null;
  pbt:          number | null;
  pat:          number | null;
  eps:          number | null;
  ebitda:       number | null;
  shares?:      number | null;   // paid-up capital / face value
  debt?:        number | null;   // current + non-current borrowings (balance-sheet quarters only)
  cash?:        number | null;   // cash + other bank balances (balance-sheet quarters only)
  filedAt:      string;
  seqId:        number;
  sourceUrl:    string;
}

/** XBRL URLs already stored. Keyed by URL: the old and new NSE endpoints number filings differently. */
export async function knownResultUrls(ticker: string): Promise<Set<string>> {
  const { rows } = await db().execute({ sql: 'SELECT source_url FROM quarterly_financials WHERE ticker = ?', args: [ticker] });
  return new Set(rows.map(r => String(r.source_url)));
}

/** Returns true when this is a new (ticker, period, basis) or a newer filing (revision) of it. */
export async function upsertFinancials(f: FinancialRow): Promise<boolean> {
  const res = await db().execute({
    sql: `INSERT INTO quarterly_financials
            (ticker, quarter, period_end, basis, revenue, other_income, finance_costs, depreciation,
             exceptional, pbt, pat, eps, ebitda, shares, debt, cash, filed_at, seq_id, source_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (ticker, period_end, basis) DO UPDATE SET
            revenue = excluded.revenue, other_income = excluded.other_income,
            finance_costs = excluded.finance_costs, depreciation = excluded.depreciation,
            exceptional = excluded.exceptional, pbt = excluded.pbt, pat = excluded.pat,
            eps = excluded.eps, ebitda = excluded.ebitda, shares = excluded.shares,
            debt = excluded.debt, cash = excluded.cash, filed_at = excluded.filed_at,
            seq_id = excluded.seq_id, source_url = excluded.source_url
          WHERE excluded.seq_id > quarterly_financials.seq_id OR quarterly_financials.shares IS NULL`,
    args: [
      f.ticker, f.quarter, f.periodEnd, f.basis, f.revenue, f.otherIncome, f.financeCosts, f.depreciation,
      f.exceptional, f.pbt, f.pat, f.eps, f.ebitda, f.shares ?? null, f.debt ?? null, f.cash ?? null,
      f.filedAt, f.seqId, f.sourceUrl,
    ],
  });
  return res.rowsAffected > 0;
}

export async function listFinancials(ticker: string): Promise<FinancialRow[]> {
  const { rows } = await db().execute({
    sql: `SELECT ticker, quarter, period_end, basis, revenue, other_income, finance_costs, depreciation,
                 exceptional, pbt, pat, eps, ebitda, shares, debt, cash, filed_at, seq_id, source_url
          FROM quarterly_financials WHERE ticker = ? ORDER BY period_end`,
    args: [ticker],
  });
  const n = (v: unknown) => (v == null ? null : Number(v));
  return rows.map(r => ({
    ticker: String(r.ticker), quarter: String(r.quarter), periodEnd: String(r.period_end),
    basis: r.basis as FinancialRow['basis'],
    revenue: n(r.revenue), otherIncome: n(r.other_income), financeCosts: n(r.finance_costs),
    depreciation: n(r.depreciation), exceptional: n(r.exceptional), pbt: n(r.pbt), pat: n(r.pat),
    eps: n(r.eps), ebitda: n(r.ebitda), shares: n(r.shares), debt: n(r.debt), cash: n(r.cash),
    filedAt: String(r.filed_at ?? ''), seqId: Number(r.seq_id),
    sourceUrl: String(r.source_url ?? ''),
  }));
}

// ── Board meetings ────────────────────────────────────────────────────────────

export interface BoardMeetingRow {
  ticker:      string;
  meetingDate: string;
  purpose:     string;
  description: string;
  isResults:   boolean;
  briefSentAt: string | null;
}

export async function upsertBoardMeeting(m: Omit<BoardMeetingRow, 'briefSentAt'>): Promise<void> {
  await db().execute({
    sql: `INSERT INTO board_meetings (ticker, meeting_date, purpose, description, is_results)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (ticker, meeting_date) DO UPDATE SET
            purpose = excluded.purpose, description = excluded.description,
            is_results = MAX(board_meetings.is_results, excluded.is_results)`,
    args: [m.ticker, m.meetingDate, m.purpose, m.description, m.isResults ? 1 : 0],
  });
}

export async function listBoardMeetings(fromIso: string, toIso: string, resultsOnly = true): Promise<BoardMeetingRow[]> {
  const { rows } = await db().execute({
    sql: `SELECT ticker, meeting_date, purpose, description, is_results, brief_sent_at FROM board_meetings
          WHERE meeting_date BETWEEN ? AND ? ${resultsOnly ? 'AND is_results = 1' : ''}
          ORDER BY meeting_date, ticker`,
    args: [fromIso, toIso],
  });
  return rows.map(r => ({
    ticker: String(r.ticker), meetingDate: String(r.meeting_date), purpose: String(r.purpose ?? ''),
    description: String(r.description ?? ''), isResults: r.is_results === 1,
    briefSentAt: (r.brief_sent_at as string) ?? null,
  }));
}

export async function markBriefSent(ticker: string, meetingDate: string): Promise<void> {
  await db().execute({
    sql: `UPDATE board_meetings SET brief_sent_at = datetime('now') WHERE ticker = ? AND meeting_date = ?`,
    args: [ticker, meetingDate],
  });
}

// ── Market signals (insider, SAST, pledge, bulk/block deals) ──────────────────

export type SignalType = 'insider' | 'sast' | 'pledge' | 'bulk_deal' | 'block_deal';

export interface SignalRow {
  id?:          number;
  ticker:       string;
  signalType:   SignalType;
  eventDate:    string;
  eventMinutes: number | null;
  party:        string;
  category:     string;
  direction:    string;
  quantity:     number | null;
  value:        number | null;   // INR
  price:        number | null;
  detail:       string;
  dedupKey:     string;
}

/** INSERT OR IGNORE on dedup_key. Returns true when the row is new. */
export async function insertSignal(s: SignalRow): Promise<boolean> {
  const res = await db().execute({
    sql: `INSERT OR IGNORE INTO market_signals
            (ticker, signal_type, event_date, event_minutes, party, category, direction,
             quantity, value, price, detail, dedup_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      s.ticker, s.signalType, s.eventDate, s.eventMinutes, s.party, s.category, s.direction,
      s.quantity, s.value, s.price, s.detail, s.dedupKey,
    ],
  });
  return res.rowsAffected > 0;
}

export async function hasSignalKeyPrefix(prefix: string): Promise<boolean> {
  const { rows } = await db().execute({
    sql: 'SELECT 1 FROM market_signals WHERE dedup_key LIKE ? LIMIT 1',
    args: [`${prefix.replace(/[%_]/g, '')}%`],
  });
  return rows.length > 0;
}

function toSignal(r: Record<string, unknown>): SignalRow {
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: Number(r.id), ticker: String(r.ticker), signalType: r.signal_type as SignalType,
    eventDate: String(r.event_date), eventMinutes: n(r.event_minutes), party: String(r.party ?? ''),
    category: String(r.category ?? ''), direction: String(r.direction ?? ''), quantity: n(r.quantity),
    value: n(r.value), price: n(r.price), detail: String(r.detail ?? ''), dedupKey: String(r.dedup_key),
  };
}

export async function listSignals(opts: { ticker?: string; sinceIso?: string; limit?: number } = {}): Promise<SignalRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.ticker)   { where.push('ticker = ?');      args.push(opts.ticker); }
  if (opts.sinceIso) { where.push('event_date >= ?'); args.push(opts.sinceIso); }
  args.push(opts.limit ?? 200);
  const { rows } = await db().execute({
    sql: `SELECT * FROM market_signals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY event_date DESC, id DESC LIMIT ?`,
    args,
  });
  return rows.map(r => toSignal(r as unknown as Record<string, unknown>));
}

export async function latestPledge(ticker: string): Promise<SignalRow | null> {
  const { rows } = await db().execute({
    sql: `SELECT * FROM market_signals WHERE ticker = ? AND signal_type = 'pledge' ORDER BY event_date DESC, id DESC LIMIT 1`,
    args: [ticker],
  });
  return rows[0] ? toSignal(rows[0] as unknown as Record<string, unknown>) : null;
}

// ── Reads for the results-day brief ───────────────────────────────────────────

export async function recentWatchFor(ticker: string, sinceIso: string, limit = 3): Promise<Array<{ date: string; title: string; watchFor: string }>> {
  const { rows } = await db().execute({
    sql: `SELECT filing_date, title, insights FROM daily_filings
          WHERE ticker = ? AND filing_date >= ? AND is_important = 1 AND insights != 'null'
          ORDER BY importance DESC, filing_date DESC LIMIT 20`,
    args: [ticker, sinceIso],
  });
  const out: Array<{ date: string; title: string; watchFor: string }> = [];
  for (const r of rows) {
    try {
      const w = (JSON.parse(String(r.insights)) as { watchFor?: string })?.watchFor?.trim();
      if (w) out.push({ date: String(r.filing_date), title: String(r.title), watchFor: w });
    } catch { /* malformed row */ }
    if (out.length >= limit) break;
  }
  return out;
}

export async function latestIngestedQuarter(ticker: string): Promise<string | null> {
  const { rows } = await db().execute({
    sql: `SELECT quarter FROM quarter_index WHERE ticker = ? AND ingested_at IS NOT NULL AND ingested_at != ''`,
    args: [ticker],
  });
  const qs = rows.map(r => String(r.quarter));
  const key = (q: string) => {
    const m = q.match(/^Q([1-4])FY(\d{2,4})$/);
    return m ? (m[2].length === 2 ? 2000 + +m[2] : +m[2]) * 4 + +m[1] : 0;
  };
  return qs.sort((a, b) => key(b) - key(a))[0] ?? null;
}
