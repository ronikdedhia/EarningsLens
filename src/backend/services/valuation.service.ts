import { getPriceBars, listFinancials, type FinancialRow } from './market-store.service';
import { ensurePrices } from './reactions.service';
import { preferredViews, buildQuarterViews, crore } from './financials.service';
import { addDays, istDate, type DailyBar } from './nse.service';

// Valuation from data already stored: NSE closes × shares (paid-up capital / face
// value from the results XBRL), trailing-12-month PAT and EBITDA from the last four
// quarters, and debt/cash from the latest balance sheet (filed with Q2 and Q4).

export interface ValuationPoint {
  date:      string;
  marketCap: number;
  pe:        number | null;
  evEbitda:  number | null;
}

export interface Range {
  current:    number | null;
  min:        number | null;
  median:     number | null;
  max:        number | null;
  percentile: number | null;   // where today sits in the 2-year history, 0–100
}

export interface Valuation {
  ticker:    string;
  asOf:      string | null;
  price:     number | null;
  marketCap: number | null;
  ttmPat:    number | null;
  ttmEbitda: number | null;
  netDebt:   number | null;
  pe:        Range;
  evEbitda:  Range;
  days:      number;   // trading days in the history
  basis:     string | null;
}

/** Quarters known at `date`: filed on or before it (no look-ahead). */
function knownAt(rows: FinancialRow[], date: string): FinancialRow[] {
  return rows.filter(r => (r.filedAt ? r.filedAt.slice(0, 10) : r.periodEnd) <= date);
}

/** TTM sum over the last four consecutive quarters known at the date; null if any is missing. */
export function ttm(rows: FinancialRow[], field: 'pat' | 'ebitda'): number | null {
  const sorted = [...rows].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const last4 = sorted.slice(-4);
  if (last4.length < 4) return null;
  // Consecutive: first and last period ends ~9 months apart
  const span = (Date.parse(last4[3].periodEnd) - Date.parse(last4[0].periodEnd)) / 86_400_000;
  if (span < 250 || span > 300) return null;
  if (last4.some(r => r[field] == null)) return null;
  return last4.reduce((s, r) => s + (r[field] as number), 0);
}

export function pointAt(rows: FinancialRow[], bar: DailyBar): ValuationPoint | null {
  const known = knownAt(rows, bar.date);
  const latestShares = [...known].reverse().find(r => r.shares)?.shares;
  if (!latestShares) return null;
  const marketCap = bar.close * latestShares;
  const pat = ttm(known, 'pat');
  const ebitda = ttm(known, 'ebitda');
  const bs = [...known].reverse().find(r => r.debt != null || r.cash != null);
  const netDebt = bs ? (bs.debt ?? 0) - (bs.cash ?? 0) : null;
  return {
    date: bar.date,
    marketCap,
    pe: pat && pat > 0 ? marketCap / pat : null,                                   // undefined for losses
    evEbitda: ebitda && ebitda > 0 && netDebt != null ? (marketCap + netDebt) / ebitda : null,
  };
}

export function range(values: Array<number | null>, current: number | null): Range {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return { current, min: null, median: null, max: null, percentile: null };
  const median = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  const percentile = current == null ? null : (xs.filter(x => x <= current).length / xs.length) * 100;
  return { current, min: xs[0], median, max: xs[xs.length - 1], percentile };
}

/** Pure: valuation history and today's position from bars and quarters (one basis). */
export function computeValuation(ticker: string, rows: FinancialRow[], bars: DailyBar[]): Valuation {
  const points = bars.map(b => pointAt(rows, b)).filter((p): p is ValuationPoint => p != null);
  const last = points[points.length - 1] ?? null;
  const known = last ? knownAt(rows, last.date) : [];
  const bs = [...known].reverse().find(r => r.debt != null || r.cash != null);
  return {
    ticker,
    asOf:      last?.date ?? null,
    price:     bars[bars.length - 1]?.close ?? null,
    marketCap: last?.marketCap ?? null,
    ttmPat:    last ? ttm(known, 'pat') : null,
    ttmEbitda: last ? ttm(known, 'ebitda') : null,
    netDebt:   bs ? (bs.debt ?? 0) - (bs.cash ?? 0) : null,
    pe:        range(points.map(p => p.pe), last?.pe ?? null),
    evEbitda:  range(points.map(p => p.evEbitda), last?.evEbitda ?? null),
    days:      points.length,
    basis:     rows[0]?.basis ?? null,
  };
}

const HISTORY_DAYS = 730;

export async function getValuation(ticker: string, opts: { fetchPrices?: boolean } = {}): Promise<Valuation> {
  const today = istDate(new Date());
  const from = addDays(today, -HISTORY_DAYS);
  if (opts.fetchPrices !== false) await ensurePrices(ticker, from, today).catch(() => {});
  const rows = preferredViews(buildQuarterViews(await listFinancials(ticker))).map(v => v.row);
  return computeValuation(ticker, rows, await getPriceBars(ticker, from));
}

// ── Formatting ────────────────────────────────────────────────────────────────

const x = (v: number | null) => (v == null ? 'n/a' : `${v.toFixed(1)}×`);

export function ordinal(n: number): string {
  const r = Math.round(n);
  const s = r % 100 >= 11 && r % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[r % 10] ?? 'th';
  return `${r}${s}`;
}

function rangeLine(label: string, r: Range): string | null {
  if (r.current == null) return null;
  const where = r.percentile == null ? '' : r.percentile >= 80 ? ', near the top of its range' : r.percentile <= 20 ? ', near the bottom of its range' : '';
  return `${label} ${x(r.current)} (2y: ${x(r.min)}–${x(r.max)}, median ${x(r.median)}; ${r.percentile == null ? '' : `${ordinal(r.percentile)} percentile`}${where})`;
}

export function valuationLines(v: Valuation): string[] {
  if (v.marketCap == null) return [];
  const lines = [`Market cap ${crore(v.marketCap)} at ₹${v.price?.toFixed(2)} (${v.asOf})`];
  const pe = rangeLine('P/E', v.pe);
  const ev = rangeLine('EV/EBITDA', v.evEbitda);
  if (pe) lines.push(pe);
  else if (v.ttmPat != null && v.ttmPat <= 0) lines.push('P/E n/a (trailing 12-month loss)');
  if (ev) lines.push(ev);
  if (v.days < 250) lines.push(`(range covers ${v.days} trading days only)`);
  return lines;
}
