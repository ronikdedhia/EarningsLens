import { escapeHtml, notifyAsync } from './telegram.service';
import { fetchBoardMeetings, istDate, addDays, istNoon, describeFetchError } from './nse.service';
import {
  upsertBoardMeeting, listBoardMeetings, markBriefSent, listFinancials, listSignals,
  recentWatchFor, latestIngestedQuarter,
} from './market-store.service';
import { listCompanies, getPromises, getRedFlags, getCompany, type GuidancePromiseRow, type RedFlagRow } from './turso.service';
import { buildQuarterViews, preferredViews, summaryLines, crore, type QuarterView } from './financials.service';
import { getValuation, valuationLines } from './valuation.service';
import { listShareholding, compareHoldings, formatHoldingsMessage } from './shareholding.service';
import { listFdaEvents, orderSummary, isBadFda, FDA_LABELS } from './corporate-events.service';
import { isNotable, signalLine } from './signals.service';
import type { SignalRow } from './market-store.service';

// ── Board meetings ────────────────────────────────────────────────────────────

export async function syncBoardMeetings(opts: { tickers?: string[]; daysAhead?: number } = {}): Promise<{ stored: number; failures: string[] }> {
  const tickers = opts.tickers ?? (await listCompanies()).map(c => c.ticker);
  const today = istDate(new Date());
  const from = istNoon(addDays(today, -7));
  const to = istNoon(addDays(today, opts.daysAhead ?? 45));
  let stored = 0;
  const failures: string[] = [];
  for (const ticker of tickers) {
    try {
      for (const m of await fetchBoardMeetings(ticker, from, to)) {
        await upsertBoardMeeting({ ticker, meetingDate: m.meetingDate, purpose: m.purpose, description: m.description, isResults: m.isResults });
        stored++;
      }
    } catch (err) {
      failures.push(`${ticker}: ${describeFetchError(err)}`);
    }
  }
  return { stored, failures };
}

// ── Brief (pure formatting) ───────────────────────────────────────────────────

export interface BriefInput {
  ticker:        string;
  name:          string;
  meetingDate:   string;
  description:   string;
  lastQuarter:   QuarterView | null;
  lastCallQuarter: string | null;
  lastCallPromises: GuidancePromiseRow[];
  olderOpenPromises: GuidancePromiseRow[];
  redFlags:      RedFlagRow[];
  watchFor:      Array<{ date: string; watchFor: string }>;
  signals:       SignalRow[];
  // Valuation, shareholding, FDA and order sections. Lines are already HTML-escaped.
  extra?:        Array<{ title: string; lines: string[] }>;
}

const SEVERITY_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

export function buildBrief(b: BriefInput): string {
  const out: string[] = [
    `📅 <b>${escapeHtml(b.ticker)}</b> results on ${escapeHtml(b.meetingDate)} — ${escapeHtml(b.name)}`,
  ];

  if (b.lastQuarter) {
    out.push('', `<b>Last quarter</b> (${escapeHtml(b.lastQuarter.row.quarter)}, ${b.lastQuarter.row.basis})`);
    out.push(...summaryLines(b.lastQuarter).map(l => `  ${escapeHtml(l)}`));
  }

  const promiseLine = (p: GuidancePromiseRow) =>
    `  · <i>"${escapeHtml(p.verbatimQuote.slice(0, 170))}"</i>` +
    `${p.timeframe ? ` — ${escapeHtml(p.timeframe)}` : ''} [${escapeHtml(p.category)}, ${p.status}]`;

  if (b.lastCallPromises.length) {
    out.push('', `<b>What management promised on the ${escapeHtml(b.lastCallQuarter ?? 'last')} call</b>`);
    out.push(...b.lastCallPromises.slice(0, 6).map(promiseLine));
  }
  if (b.olderOpenPromises.length) {
    out.push('', `<b>Older promises still open</b> (${b.olderOpenPromises.length})`);
    out.push(...b.olderOpenPromises.slice(0, 3).map(p => `${promiseLine(p)} (${escapeHtml(p.quarterPromised)})`));
  }

  const flags = [...b.redFlags].sort((x, y) => (SEVERITY_ORDER[x.severity] ?? 9) - (SEVERITY_ORDER[y.severity] ?? 9));
  if (flags.length) {
    out.push('', `<b>Red flags from the last call</b>`);
    out.push(...flags.slice(0, 5).map(f =>
      `  · ${f.severity === 'High' ? '🔴' : f.severity === 'Medium' ? '🟡' : '⚪'} ${escapeHtml(f.flagType.replace(/_/g, ' '))}: <i>"${escapeHtml(f.evidence.slice(0, 140))}"</i>`));
  }

  if (b.watchFor.length) {
    out.push('', '<b>What to watch</b> (from recent filings)');
    out.push(...b.watchFor.map(w => `  · ${escapeHtml(w.watchFor.slice(0, 200))} <i>${escapeHtml(w.date)}</i>`));
  }

  if (b.signals.length) {
    const notable = b.signals.filter(isNotable);
    out.push('', `<b>Insider &amp; deal activity, last 90 days</b> (${b.signals.length}${notable.length ? `, ${notable.length} ⚠️` : ''})`);
    out.push(...(notable.length ? notable : b.signals).slice(0, 5).map(signalLine));
  }

  for (const s of b.extra ?? []) {
    if (!s.lines.length) continue;
    out.push('', `<b>${escapeHtml(s.title)}</b>`, ...s.lines.map(l => `  ${l}`));
  }

  if (out.length === 1) out.push('', 'No stored history for this company yet.');
  return out.join('\n');
}

// ── Assemble and send ─────────────────────────────────────────────────────────

export async function assembleBrief(ticker: string, meetingDate: string, description: string): Promise<BriefInput> {
  const today = istDate(new Date());
  const [company, financials, promises, lastCall, signals, watchFor] = await Promise.all([
    getCompany(ticker),
    listFinancials(ticker),
    getPromises(ticker),
    latestIngestedQuarter(ticker),
    listSignals({ ticker, sinceIso: addDays(today, -90), limit: 50 }),
    recentWatchFor(ticker, addDays(today, -120)),
  ]);
  const views = preferredViews(buildQuarterViews(financials));
  const redFlags = lastCall ? await getRedFlags(ticker, lastCall) : [];

  const [valuation, holdings, fda, orders] = await Promise.all([
    getValuation(ticker).then(valuationLines).catch(() => [] as string[]),
    listShareholding(ticker).catch(() => []),
    listFdaEvents({ ticker, sinceIso: addDays(today, -180), limit: 6 }).catch(() => []),
    orderSummary(ticker).catch(() => null),
  ]);
  const cur = holdings[holdings.length - 1];
  const holdingLines = cur
    ? formatHoldingsMessage(ticker, cur, compareHoldings(holdings[holdings.length - 2] ?? null, cur)).split('\n').slice(1).map(l => l.trim())
    : [];
  const extra = [
    { title: 'Valuation', lines: valuation.map(escapeHtml) },
    { title: `Shareholding${cur ? ` (${cur.periodEnd})` : ''}`, lines: holdingLines },
    { title: 'US FDA, last 6 months', lines: fda.map(e => `${isBadFda(e.eventType) ? '🔴' : '🟢'} ${escapeHtml(FDA_LABELS[e.eventType])}: ${escapeHtml(e.title.slice(0, 120))} <i>${escapeHtml(e.eventDate)}</i>`) },
    { title: 'Order wins, last 12 months', lines: orders && orders.last12mCount
      ? [escapeHtml(`${orders.last12mCount} orders, ${crore(orders.last12mInr)}${orders.coverage != null ? ` = ${orders.coverage.toFixed(2)}× TTM revenue` : ''}`)]
      : [] },
  ];

  return {
    extra,
    ticker,
    name:              company?.name ?? ticker,
    meetingDate,
    description,
    lastQuarter:       views[views.length - 1] ?? null,
    lastCallQuarter:   lastCall,
    lastCallPromises:  promises.filter(p => p.quarterPromised === lastCall),
    olderOpenPromises: promises.filter(p => p.quarterPromised !== lastCall && p.status === 'pending'),
    redFlags,
    watchFor,
    signals,
  };
}

/**
 * Evening job: refreshes board meetings, then sends one brief per results
 * meeting tomorrow (IST) that hasn't had one yet.
 */
export async function sendResultsBriefs(): Promise<{ sent: string[]; failures: string[] }> {
  const sync = await syncBoardMeetings();
  const tomorrow = addDays(istDate(new Date()), 1);
  const meetings = (await listBoardMeetings(tomorrow, tomorrow)).filter(m => !m.briefSentAt);
  const sent: string[] = [];
  const failures = [...sync.failures];
  for (const m of meetings) {
    try {
      await notifyAsync(buildBrief(await assembleBrief(m.ticker, m.meetingDate, m.description)));
      await markBriefSent(m.ticker, m.meetingDate);
      sent.push(m.ticker);
    } catch (err) {
      failures.push(`${m.ticker} brief: ${String((err as Error).message ?? err).slice(0, 100)}`);
    }
  }
  return { sent, failures };
}
