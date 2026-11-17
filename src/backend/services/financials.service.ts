import { xbrlFacts, num } from '../utils/xbrl';
import { escapeHtml } from './telegram.service';
import { fetchResultFilings, fetchLegacyResultFilings, nseArchiveText, type NseResultFiling } from './nse.service';
import { knownResultUrls, upsertFinancials, listFinancials, type FinancialRow } from './market-store.service';
import { getPromises, listCompanies, type GuidancePromiseRow } from './turso.service';

// Figures come from the XBRL file attached to each results filing: the same
// numbers as the PDF, machine-readable, so no LLM reads them. XBRL values are
// full rupees regardless of the "in lakhs/crores" the company prints.

const CRORE = 1e7;

/** Period end → Indian FY quarter label: 2026-09-30 → "Q2FY27". */
export function quarterFromPeriodEnd(periodEnd: string): string | null {
  const m = periodEnd.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const year = +m[1];
  const month = +m[2];
  const map: Record<number, [number, number]> = { 6: [1, year + 1], 9: [2, year + 1], 12: [3, year + 1], 3: [4, year] };
  const hit = map[month];
  return hit ? `Q${hit[0]}FY${String(hit[1]).slice(-2)}` : null;
}

/**
 * Operating EBITDA = PBT − exceptional items + finance costs + depreciation − other income.
 * Null when a component the formula needs is missing (e.g. bank formats).
 */
export function computeEbitda(f: Pick<FinancialRow, 'pbt' | 'financeCosts' | 'depreciation' | 'otherIncome' | 'exceptional'>): number | null {
  if (f.pbt == null || f.financeCosts == null || f.depreciation == null) return null;
  return f.pbt - (f.exceptional ?? 0) + f.financeCosts + f.depreciation - (f.otherIncome ?? 0);
}

export type ParsedResults = Omit<FinancialRow, 'ticker' | 'filedAt' | 'seqId' | 'sourceUrl'>;

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

/** Reads the quarter (context OneD) from an Integrated Filing XBRL. Null if it isn't a single quarter. */
export function parseResultsXbrl(xml: string): ParsedResults | null {
  const facts = xbrlFacts(xml);
  const q = facts.OneD;
  const bs = facts.OneI ?? {};   // balance sheet, present in half-year and annual filings
  if (!q) return null;
  const start = q.DateOfStartOfReportingPeriod;
  const end = q.DateOfEndOfReportingPeriod;
  if (!start || !end) return null;
  const len = daysBetween(start, end);
  if (len < 80 || len > 100) return null; // a half-year or full-year context, not a quarter
  const quarter = quarterFromPeriodEnd(end);
  if (!quarter) return null;

  const row: ParsedResults = {
    quarter,
    periodEnd:    end,
    basis:        /consolidated/i.test(q.NatureOfReportStandaloneConsolidated ?? '') ? 'Consolidated' : 'Standalone',
    // Banks and NBFC forms use different names; Ind-AS companies use the first.
    revenue:      num(q.RevenueFromOperations) ?? num(q.InterestEarned) ?? num(q.Income),
    otherIncome:  num(q.OtherIncome),
    financeCosts: num(q.FinanceCosts),
    depreciation: num(q.DepreciationDepletionAndAmortisationExpense),
    exceptional:  num(q.ExceptionalItemsBeforeTax),
    pbt:          num(q.ProfitBeforeTax) ?? num(q.ProfitLossBeforeTax),
    pat:          num(q.ProfitLossForPeriod) ?? num(q.ProfitLossForThePeriod),
    eps:          num(q.BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations)
                  ?? num(q.BasicEarningsLossPerShareFromContinuingOperations)
                  ?? num(q.BasicEarningsPerShareAfterExtraordinaryItems),
    ebitda:       null,
    shares:       null,
    debt:         null,
    cash:         null,
  };
  row.ebitda = computeEbitda(row);

  const paidUp = num(q.PaidUpValueOfEquityShareCapital);
  const face = num(q.FaceValueOfEquityShareCapital);
  row.shares = paidUp != null && face ? paidUp / face : null;
  const sum = (...xs: Array<number | null>) => (xs.every(x => x == null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0));
  row.debt = sum(num(bs.BorrowingsCurrent), num(bs.BorrowingsNoncurrent));
  row.cash = sum(num(bs.CashAndCashEquivalents), num(bs.BankBalanceOtherThanCashAndCashEquivalents));
  return row;
}

// ── Comparisons ───────────────────────────────────────────────────────────────

export interface QuarterView {
  row:          FinancialRow;
  ebitdaMargin: number | null;   // %
  patMargin:    number | null;   // %
  qoq:          Changes | null;
  yoy:          Changes | null;
}

export interface Changes {
  vsQuarter:       string;
  revenuePct:      number | null;
  ebitdaPct:       number | null;
  patPct:          number | null;
  ebitdaMarginBps: number | null;
  patMarginBps:    number | null;
}

const pct = (cur: number | null, prev: number | null) =>
  cur == null || prev == null || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100;
const margin = (x: number | null, rev: number | null) => (x == null || !rev ? null : (x / rev) * 100);

function prevQuarterEnd(periodEnd: string, quartersBack: number): string {
  const d = new Date(`${periodEnd}T00:00:00Z`);
  const firstOfNext = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1 - 3 * quartersBack, 1));
  firstOfNext.setUTCDate(0); // last day of the previous month
  return firstOfNext.toISOString().slice(0, 10);
}

function changes(cur: FinancialRow, prev: FinancialRow | undefined): Changes | null {
  if (!prev) return null;
  const cm = { e: margin(cur.ebitda, cur.revenue), p: margin(cur.pat, cur.revenue) };
  const pm = { e: margin(prev.ebitda, prev.revenue), p: margin(prev.pat, prev.revenue) };
  return {
    vsQuarter:       prev.quarter,
    revenuePct:      pct(cur.revenue, prev.revenue),
    ebitdaPct:       pct(cur.ebitda, prev.ebitda),
    patPct:          pct(cur.pat, prev.pat),
    ebitdaMarginBps: cm.e == null || pm.e == null ? null : (cm.e - pm.e) * 100,
    patMarginBps:    cm.p == null || pm.p == null ? null : (cm.p - pm.p) * 100,
  };
}

/** One view per row, each with QoQ and YoY against the same basis. */
export function buildQuarterViews(rows: FinancialRow[]): QuarterView[] {
  const key = (r: Pick<FinancialRow, 'basis' | 'periodEnd'>) => `${r.basis}|${r.periodEnd}`;
  const index = new Map(rows.map(r => [key(r), r]));
  return [...rows]
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.basis.localeCompare(b.basis))
    .map(row => ({
      row,
      ebitdaMargin: margin(row.ebitda, row.revenue),
      patMargin:    margin(row.pat, row.revenue),
      qoq: changes(row, index.get(key({ basis: row.basis, periodEnd: prevQuarterEnd(row.periodEnd, 1) }))),
      yoy: changes(row, index.get(key({ basis: row.basis, periodEnd: prevQuarterEnd(row.periodEnd, 4) }))),
    }));
}

/** Consolidated when the company files it, otherwise standalone. */
export function preferredViews(views: QuarterView[]): QuarterView[] {
  const hasConsolidated = new Set(views.filter(v => v.row.basis === 'Consolidated').map(v => v.row.periodEnd));
  return views.filter(v => v.row.basis === 'Consolidated' || !hasConsolidated.has(v.row.periodEnd));
}

// ── Formatting ────────────────────────────────────────────────────────────────

export const crore = (v: number | null) =>
  v == null ? 'n/a' : `₹${(v / CRORE).toLocaleString('en-IN', { maximumFractionDigits: v / CRORE >= 1000 ? 0 : 1 })} Cr`;
const signed = (v: number | null, unit: string, digits = 1) =>
  v == null ? null : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${unit}`;

function changeText(c: Changes | null, field: 'revenuePct' | 'ebitdaPct' | 'patPct', label: string): string | null {
  const v = c?.[field] ?? null;
  return v == null ? null : `${signed(v, '%')} ${label}`;
}

/** "₹746.5 Cr (+12.3% YoY, +4.1% QoQ)" */
function lineWithChanges(name: string, value: number | null, v: QuarterView, field: 'revenuePct' | 'ebitdaPct' | 'patPct'): string {
  const parts = [changeText(v.yoy, field, 'YoY'), changeText(v.qoq, field, 'QoQ')].filter(Boolean);
  return `${name} ${crore(value)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

export function summaryLines(v: QuarterView): string[] {
  const lines = [lineWithChanges('Revenue', v.row.revenue, v, 'revenuePct')];
  if (v.row.ebitda != null) {
    const bps = v.yoy?.ebitdaMarginBps ?? null;
    lines.push(
      `${lineWithChanges('EBITDA', v.row.ebitda, v, 'ebitdaPct')}, margin ${v.ebitdaMargin?.toFixed(1)}%` +
      (bps == null ? '' : ` (${signed(bps, ' bp YoY', 0)})`),
    );
  }
  lines.push(`${lineWithChanges('PAT', v.row.pat, v, 'patPct')}${v.row.eps != null ? ` · EPS ₹${v.row.eps.toFixed(2)}` : ''}`);
  if (v.row.exceptional) lines.push(`Includes exceptional items of ${crore(v.row.exceptional)}`);
  return lines;
}

export const NUMERIC_PROMISE_CATEGORIES = new Set(['Revenue', 'Margin', 'Volume', 'Guidance', 'Capex']);

/** Numeric promises made before this quarter: what results should be read against. */
export function relevantPromises(promises: GuidancePromiseRow[], quarter: string, limit = 3): GuidancePromiseRow[] {
  const key = (q: string) => {
    const m = q.match(/^Q([1-4])FY(\d{2,4})$/);
    return m ? (m[2].length === 2 ? 2000 + +m[2] : +m[2]) * 4 + +m[1] : 0;
  };
  const target = key(quarter);
  return promises
    .filter(p => NUMERIC_PROMISE_CATEGORIES.has(p.category))
    .filter(p => key(p.quarterPromised) < target && key(p.quarterPromised) >= target - 4)
    .sort((a, b) => key(b.quarterPromised) - key(a.quarterPromised) || b.confidenceScore - a.confidenceScore)
    .slice(0, limit);
}

export function formatResultsMessage(ticker: string, v: QuarterView, promises: GuidancePromiseRow[]): string {
  const lines = [
    `📊 <b>${escapeHtml(ticker)}</b> results ${escapeHtml(v.row.quarter)} (${v.row.basis})`,
    ...summaryLines(v).map(l => `  ${escapeHtml(l)}`),
  ];
  if (promises.length) {
    lines.push('', 'Management guided:');
    for (const p of promises) {
      lines.push(`  · <i>"${escapeHtml(p.verbatimQuote.slice(0, 160))}"</i> (${escapeHtml(p.quarterPromised)}${p.timeframe ? `, ${escapeHtml(p.timeframe)}` : ''}) — ${p.status}`);
    }
  }
  return lines.join('\n');
}

/** Plain-text block the promise resolver reads alongside the transcript. */
export function evidenceText(v: QuarterView): string {
  return `[Reported results ${v.row.quarter}, ${v.row.basis}, from the exchange filing]\n${summaryLines(v).join('\n')}`;
}

export async function financialsEvidence(ticker: string, quarter: string): Promise<string> {
  const views = preferredViews(buildQuarterViews(await listFinancials(ticker)));
  const v = views.find(x => x.row.quarter === quarter);
  return v ? evidenceText(v) : '';
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/** Latest filing per (period, basis): revisions supersede originals. */
export function latestFilings(filings: NseResultFiling[]): NseResultFiling[] {
  const best = new Map<string, NseResultFiling>();
  for (const f of filings) {
    const k = `${f.periodEnd}|${f.basis}`;
    const cur = best.get(k);
    if (!cur || f.seqId > cur.seqId) best.set(k, f);
  }
  return [...best.values()];
}

export interface NewResult {
  ticker:  string;
  message: string;
}

/**
 * Pulls new results filings for every tracked company. Returns a Telegram
 * message for each newly reported quarter (preferred basis only).
 */
// TTM figures at the start of a 2-year valuation window need the four quarters before it.
const LEGACY_FROM = '2023-09-30';

export async function syncFinancials(opts: { tickers?: string[]; notifyOlderThanDays?: number; includeLegacy?: boolean; reparse?: boolean } = {}): Promise<{ stored: number; messages: NewResult[]; failures: string[] }> {
  const tickers = opts.tickers ?? (await listCompanies()).map(c => c.ticker);
  const messages: NewResult[] = [];
  const failures: string[] = [];
  let stored = 0;
  // Only announce quarters filed recently; a backfill shouldn't post two years of results.
  const announceSince = Date.now() - (opts.notifyOlderThanDays ?? 7) * 86_400_000;

  for (const ticker of tickers) {
    try {
      // reparse: read every XBRL again (fills columns added later, e.g. shares/debt/cash)
      const known = opts.reparse ? new Set<string>() : await knownResultUrls(ticker);
      const filings = await fetchResultFilings(ticker);
      // Pre-Mar-2025 quarters sit on NSE's older endpoint; needed for a 2-year valuation range.
      if (opts.includeLegacy) {
        filings.push(...(await fetchLegacyResultFilings(ticker).catch(() => [])).filter(f => f.periodEnd >= LEGACY_FROM));
      }
      const fresh = latestFilings(filings).filter(f => !known.has(f.xbrlUrl));
      const newKeys: string[] = [];
      for (const f of fresh) {
        try {
          const parsed = parseResultsXbrl(await nseArchiveText(f.xbrlUrl));
          if (!parsed) continue;
          const changed = await upsertFinancials({ ...parsed, ticker, filedAt: f.filedAt, seqId: f.seqId, sourceUrl: f.xbrlUrl });
          if (changed) {
            stored++;
            if (Date.parse(`${f.filedAt.slice(0, 10)}T00:00:00+05:30`) >= announceSince) newKeys.push(`${parsed.basis}|${parsed.periodEnd}`);
          }
        } catch (err) {
          console.error(`[financials] ${ticker} ${f.periodEnd} ${f.basis}:`, String(err).slice(0, 160));
        }
      }
      if (!newKeys.length) continue;

      const views = buildQuarterViews(await listFinancials(ticker));
      const preferred = new Set(preferredViews(views).map(v => `${v.row.basis}|${v.row.periodEnd}`));
      const promises = await getPromises(ticker);
      for (const k of newKeys.filter(k => preferred.has(k))) {
        const v = views.find(x => `${x.row.basis}|${x.row.periodEnd}` === k)!;
        messages.push({ ticker, message: formatResultsMessage(ticker, v, relevantPromises(promises, v.row.quarter)) });
      }
    } catch (err) {
      failures.push(`${ticker}: ${String((err as Error).message ?? err).slice(0, 80)}`);
    }
  }
  return { stored, messages, failures };
}
