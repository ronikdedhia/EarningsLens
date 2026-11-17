import { xbrlFacts, num } from '../utils/xbrl';
import { escapeHtml } from './telegram.service';
import {
  fetchInsiderFilings, fetchSastReg29, fetchPledgeData, fetchLargeDeals, nseArchiveText,
  parseNseDateTime, istDate, describeFetchError,
} from './nse.service';
import { insertSignal, hasSignalKeyPrefix, latestPledge, type SignalRow } from './market-store.service';
import { listCompanies } from './turso.service';
import { crore } from './financials.service';

// ── Parsers (pure) ────────────────────────────────────────────────────────────

export interface InsiderTxn {
  person:     string;
  category:   string;
  type:       string;
  mode:       string;
  quantity:   number | null;
  value:      number | null;
  heldAfterPct: number | null;   // fraction of share capital, e.g. 0.0011
  tradeDate:  string;
}

/** One row per Disclosure1, Disclosure2, … context in a PIT Reg 7 XBRL file. */
export function parseInsiderXbrl(xml: string): InsiderTxn[] {
  const facts = xbrlFacts(xml);
  return Object.keys(facts)
    .filter(k => /^Disclosure\d+$/.test(k))
    .sort((a, b) => +a.slice(10) - +b.slice(10))
    .map(k => {
      const f = facts[k];
      return {
        person:       f.NameOfThePerson ?? '',
        category:     f.CategoryOfPerson ?? '',
        type:         f.SecuritiesAcquiredOrDisposedTransactionType ?? '',
        mode:         f.ModeOfAcquisitionOrDisposal ?? '',
        quantity:     num(f.SecuritiesAcquiredOrDisposedNumberOfSecurity),
        value:        num(f.SecuritiesAcquiredOrDisposedValueOfSecurity),
        heldAfterPct: num(f.SecuritiesHeldPostAcquistionOrDisposalPercentageOfShareholding),
        tradeDate:    f.DateOfAllotmentAdviceOrAcquisitionOfSharesOrSaleOfSharesSpecifyFromDate ?? '',
      };
    })
    .filter(t => t.person || t.quantity != null);
}

/** "Pledge Revoke" → "pledge_release", "Sell" → "sell". */
export function insiderDirection(type: string, mode = ''): string {
  const t = `${type} ${mode}`.toLowerCase();
  if (/invoc/.test(t)) return 'pledge_invoked';
  if (/revok|release/.test(t)) return 'pledge_release';
  if (/pledge|encumb/.test(t)) return 'pledge';
  if (/sell|sale|dispos/.test(type.toLowerCase())) return 'sell';
  if (/buy|acqui|purchase|allot/.test(type.toLowerCase())) return 'buy';
  return type.toLowerCase().replace(/\s+/g, '_') || 'other';
}

export function isPromoter(category: string): boolean {
  return /promoter/i.test(category);
}

export function insiderSignals(ticker: string, appId: string, broadcast: string, txns: InsiderTxn[]): SignalRow[] {
  const when = parseNseDateTime(broadcast);
  return txns.map((t, i) => ({
    ticker,
    signalType:   'insider',
    eventDate:    when?.date ?? (t.tradeDate || istDate(new Date())),
    eventMinutes: when?.minutes ?? null,
    party:        t.person,
    category:     t.category,
    direction:    insiderDirection(t.type, t.mode),
    quantity:     t.quantity,
    value:        t.value,
    price:        t.quantity && t.value ? t.value / t.quantity : null,
    detail:       [t.mode, t.heldAfterPct != null ? `holds ${(t.heldAfterPct * 100).toFixed(2)}% after` : ''].filter(Boolean).join(', '),
    dedupKey:     `insider:${appId}:${i}`,
  }));
}

export function sastSignals(ticker: string, rows: Array<Record<string, string | null>>): SignalRow[] {
  return rows.map(r => {
    const when = parseNseDateTime(r.timestamp) ?? parseNseDateTime(r.time);
    const sale = /sale|dispos/i.test(r.acqSaleType ?? '');
    const qty = num((sale ? r.noOfShareSale : r.noOfShareAcq) ?? undefined) ?? num(r.noOfShareAcq ?? undefined);
    return {
      ticker,
      signalType:   'sast' as const,
      eventDate:    when?.date ?? '',
      eventMinutes: when?.minutes ?? null,
      party:        (r.acquirerName ?? '').trim(),
      category:     r.promoterType === 'Y' ? 'Promoter' : 'Non-promoter',
      direction:    sale ? 'sell' : 'buy',
      quantity:     qty,
      value:        null,
      price:        null,
      detail:       [r.regType, r.acquisitionMode, r.totAcqDiluted ? `${r.totAcqDiluted}% of diluted capital` : ''].filter(Boolean).join(', '),
      dedupKey:     `sast:${ticker}:${r.application_no ?? `${r.acquirerName}:${r.timestamp}`}`,
    };
  }).filter(s => s.eventDate);
}

export function dealSignals(kind: 'bulk_deal' | 'block_deal', ticker: string, rows: Array<Record<string, string | number | null>>): SignalRow[] {
  return rows
    .filter(r => String(r.BD_SYMBOL ?? '').toUpperCase() === ticker)
    .map(r => {
      const date = parseNseDateTime(String(r.BD_DT_DATE ?? ''))?.date ?? '';
      const qty = num(String(r.BD_QTY_TRD ?? ''));
      const price = num(String(r.BD_TP_WATP ?? ''));
      const client = String(r.BD_CLIENT_NAME ?? '').trim();
      const side = String(r.BD_BUY_SELL ?? '').toUpperCase();
      return {
        ticker,
        signalType:   kind,
        eventDate:    date,
        eventMinutes: 16 * 60,   // deals are published after the close
        party:        client,
        category:     '',
        direction:    side === 'SELL' ? 'sell' : 'buy',
        quantity:     qty,
        value:        qty != null && price != null ? qty * price : null,
        price,
        detail:       '',
        dedupKey:     `${kind}:${ticker}:${date}:${client}:${side}:${qty}`,
      };
    })
    .filter(s => s.eventDate);
}

/** Pledge snapshot per shareholding quarter; direction compares with the previous snapshot. */
export function pledgeSignal(
  ticker: string, row: Record<string, string | null>, previous: SignalRow | null, today: string,
): SignalRow | null {
  const shp = parseNseDateTime(row.shp)?.date;
  if (!shp) return null;
  // NSE's percSharesPledged is pledged shares as a % of all (demat) shares.
  const pct = num(String(row.percSharesPledged ?? '').trim());
  const shares = num(String(row.numSharesPledged ?? '').trim());
  const promoterHolding = num(String(row.totPromoterHolding ?? '').trim());
  const ofPromoter = shares != null && promoterHolding ? (shares / promoterHolding) * 100 : null;
  const prevPct = previous ? num(previous.detail.match(/^([\d.]+)%/)?.[1]) : null;
  let direction = 'snapshot';
  if (prevPct != null && pct != null) direction = pct > prevPct ? 'increase' : pct < prevPct ? 'decrease' : 'unchanged';
  return {
    ticker,
    signalType:   'pledge',
    eventDate:    today,
    eventMinutes: null,
    party:        'Promoters',
    category:     'Promoter',
    direction,
    quantity:     shares,
    value:        null,
    price:        null,
    // Must start with "<pct>%": the next snapshot reads the previous value from here.
    detail:       `${pct ?? '?'}% of shares pledged` +
                  (ofPromoter != null ? ` (${ofPromoter.toFixed(1)}% of promoter holding)` : '') +
                  ` as of ${shp}` + (prevPct != null ? `, was ${prevPct}%` : ''),
    dedupKey:     `pledge:${ticker}:${shp}:${pct}`,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Worth a ⚠: promoters selling or pledging, invoked pledges, rising pledge %, large deals. */
export function isNotable(s: SignalRow): boolean {
  if (s.signalType === 'bulk_deal' || s.signalType === 'block_deal') return true;
  if (s.signalType === 'pledge') return s.direction === 'increase';
  if (s.direction === 'pledge_invoked') return true;
  return isPromoter(s.category) && ['sell', 'pledge'].includes(s.direction);
}

const ICON: Record<string, string> = {
  buy: '🟢', sell: '🔴', pledge: '🟠', pledge_release: '⚪', pledge_invoked: '🔴', increase: '🟠', decrease: '⚪',
};

export function signalLine(s: SignalRow): string {
  const what = s.signalType === 'insider' ? 'Insider' : s.signalType === 'sast' ? 'SAST'
    : s.signalType === 'pledge' ? 'Pledge' : s.signalType === 'bulk_deal' ? 'Bulk deal' : 'Block deal';
  const amount = s.value != null ? crore(s.value)
    : s.quantity != null ? `${s.quantity.toLocaleString('en-IN')} sh` : '';
  const who = [s.party, s.category && s.signalType !== 'pledge' ? `(${s.category})` : ''].filter(Boolean).join(' ');
  const body = s.signalType === 'pledge'
    ? s.detail
    : `${s.direction.replace('_', ' ')} ${amount}${s.price ? ` @ ₹${s.price.toFixed(2)}` : ''} — ${who}`;
  return `  ${ICON[s.direction] ?? '·'}${isNotable(s) ? '⚠️' : ''} ${escapeHtml(what)}: ${escapeHtml(body.trim())} <i>${escapeHtml(s.eventDate)}</i>`;
}

export function formatSignalsMessage(signals: SignalRow[]): string | null {
  if (!signals.length) return null;
  const byTicker = new Map<string, SignalRow[]>();
  for (const s of signals) (byTicker.get(s.ticker) ?? byTicker.set(s.ticker, []).get(s.ticker)!).push(s);
  const notable = signals.filter(isNotable).length;
  const head = `🕵️ <b>Insider &amp; deal activity</b> — ${signals.length} new${notable ? `, ${notable} ⚠️` : ''}`;
  const sections = [...byTicker].map(([t, rows]) =>
    `<b>${escapeHtml(t)}</b>\n${rows.slice(0, 12).map(signalLine).join('\n')}${rows.length > 12 ? `\n  … ${rows.length - 12} more` : ''}`);
  return `${head}\n\n${sections.join('\n\n')}`;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export interface SignalsSyncResult {
  added:    SignalRow[];
  failures: string[];
}

/**
 * Pulls insider trades, SAST disclosures, the pledge snapshot and bulk/block deals
 * for every tracked company over the last `sinceDays`.
 */
export async function syncSignals(opts: { sinceDays?: number; tickers?: string[] } = {}): Promise<SignalsSyncResult> {
  const tickers = opts.tickers ?? (await listCompanies()).map(c => c.ticker);
  const to = new Date();
  const from = new Date(to.getTime() - (opts.sinceDays ?? 7) * 86_400_000);
  const added: SignalRow[] = [];
  const failures: string[] = [];

  const keep = async (rows: SignalRow[]) => {
    for (const r of rows) if (await insertSignal(r)) added.push(r);
  };
  const attempt = async (ticker: string, what: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (err) { failures.push(`${ticker} ${what}: ${describeFetchError(err)}`); }
  };

  for (const ticker of tickers) {
    await attempt(ticker, 'insider', async () => {
      for (const f of await fetchInsiderFilings(ticker, from, to)) {
        if (await hasSignalKeyPrefix(`insider:${f.appId}:`)) continue;
        const txns = parseInsiderXbrl(await nseArchiveText(f.xmlUrl));
        await keep(insiderSignals(ticker, f.appId, f.broadcast, txns));
      }
    });
    await attempt(ticker, 'SAST', async () => {
      const sinceIso = istDate(from);
      await keep(sastSignals(ticker, await fetchSastReg29(ticker)).filter(s => s.eventDate >= sinceIso));
    });
    await attempt(ticker, 'pledge', async () => {
      const [row] = await fetchPledgeData(ticker);
      const sig = row ? pledgeSignal(ticker, row, await latestPledge(ticker), istDate(to)) : null;
      if (sig) await keep([sig]);
    });
    for (const kind of ['bulk_deals', 'block_deals'] as const) {
      await attempt(ticker, kind, async () => {
        await keep(dealSignals(kind === 'bulk_deals' ? 'bulk_deal' : 'block_deal', ticker, await fetchLargeDeals(kind, ticker, from, to)));
      });
    }
  }
  return { added, failures };
}
