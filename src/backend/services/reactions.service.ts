import { fetchDailyBars, addDays, istDate, MARKET_CLOSE_MINUTES, NIFTY, describeFetchError, type DailyBar } from './nse.service';
import {
  getPriceRange, savePriceBars, getPriceBars, listEventsNeedingReaction, upsertReaction,
  type MarketEvent, type ReactionRow,
} from './market-store.service';

export const HORIZONS = [1, 5, 20] as const;

// ── Return maths (pure) ───────────────────────────────────────────────────────

/**
 * Index of the last close before the market could react.
 * - Known time at/after 15:30 IST: the event day's own close is the base.
 * - During or before market hours, or time unknown: the previous session's close,
 *   so day 1 is the event day. Unknown is treated as "during" so the reaction is
 *   never missed; at worst day 1 includes some pre-event movement.
 */
export function baseIndex(bars: DailyBar[], eventDate: string, minutes: number | null): number {
  const afterClose = minutes != null && minutes >= MARKET_CLOSE_MINUTES;
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (afterClose ? bars[i].date <= eventDate : bars[i].date < eventDate) idx = i;
    else break;
  }
  return idx;
}

/**
 * Compounds close/prevClose. NSE's prevClose is adjusted on split, bonus and
 * dividend ex-dates, so a 1:10 split doesn't show up as a -90% "reaction".
 */
export function compound(bars: DailyBar[], fromExclusive: number, toInclusive: number): number {
  let growth = 1;
  for (let i = fromExclusive + 1; i <= toInclusive; i++) growth *= bars[i].close / bars[i].prevClose;
  return growth - 1;
}

/** Index return between two dates, compounding the index's own daily moves. */
export function indexReturn(index: DailyBar[], fromExclusive: string, toInclusive: string): number | null {
  const days = index.filter(b => b.date > fromExclusive && b.date <= toInclusive);
  if (!days.length) return null;
  return days.reduce((g, b) => g * (b.close / b.prevClose), 1) - 1;
}

export interface Reaction {
  baseDate: string | null;
  ret:      Record<number, number | null>;
  nifty:    Record<number, number | null>;
  complete: boolean;
}

export function computeReaction(stock: DailyBar[], index: DailyBar[], eventDate: string, minutes: number | null): Reaction {
  const base = baseIndex(stock, eventDate, minutes);
  const ret: Record<number, number | null> = {};
  const nifty: Record<number, number | null> = {};
  for (const h of HORIZONS) { ret[h] = null; nifty[h] = null; }
  if (base < 0) return { baseDate: null, ret, nifty, complete: false };
  for (const h of HORIZONS) {
    const end = base + h;
    if (end >= stock.length) continue;
    ret[h] = compound(stock, base, end);
    nifty[h] = indexReturn(index, stock[base].date, stock[end].date);
  }
  return { baseDate: stock[base].date, ret, nifty, complete: ret[20] != null };
}

// ── Summary (pure) ────────────────────────────────────────────────────────────

export interface BucketStats {
  eventType:  string;
  label:      string;
  n:          number;
  horizons: Record<number, {
    n:          number;
    avgReturn:  number | null;   // %
    avgExcess:  number | null;   // % vs NIFTY 50
    medianExcess: number | null;
    hitRate:    number | null;   // % of events that beat NIFTY 50
  }>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarize(rows: ReactionRow[]): BucketStats[] {
  const groups = new Map<string, ReactionRow[]>();
  for (const r of rows) {
    const k = `${r.eventType}|${r.label}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const pick = (r: ReactionRow, h: number) =>
    h === 1 ? [r.ret1, r.nifty1] : h === 5 ? [r.ret5, r.nifty5] : [r.ret20, r.nifty20];

  return [...groups].map(([k, rs]) => {
    const [eventType, label] = k.split('|');
    const horizons: BucketStats['horizons'] = {};
    for (const h of HORIZONS) {
      const pairs = rs.map(r => pick(r, h)).filter(([a]) => a != null) as Array<[number, number | null]>;
      const excess = pairs.filter(([, b]) => b != null).map(([a, b]) => (a - (b as number)) * 100);
      horizons[h] = {
        n:            pairs.length,
        avgReturn:    mean(pairs.map(([a]) => a * 100)),
        avgExcess:    mean(excess),
        medianExcess: median(excess),
        hitRate:      excess.length ? (excess.filter(x => x > 0).length / excess.length) * 100 : null,
      };
    }
    return { eventType, label, n: rs.length, horizons };
  }).sort((a, b) => a.eventType.localeCompare(b.eventType) || b.label.localeCompare(a.label));
}

// ── Sync ──────────────────────────────────────────────────────────────────────

const LOOKBACK_DAYS = 400; // events older than this aren't backfilled

/** Fills price_history for `symbol` so it covers [fromIso, today]. */
export async function ensurePrices(symbol: string, fromIso: string, todayIso: string): Promise<void> {
  const { min, max } = await getPriceRange(symbol);
  const ranges: Array<[string, string]> = [];
  if (!min || !max) ranges.push([fromIso, todayIso]);
  else {
    if (fromIso < min) ranges.push([fromIso, addDays(min, -1)]);
    // Re-read the last few days: NSE sometimes posts a day's bar late.
    if (max < todayIso) ranges.push([addDays(max, -3), todayIso]);
  }
  for (const [a, b] of ranges) {
    if (a > b) continue;
    await savePriceBars(symbol, await fetchDailyBars(symbol, a, b));
  }
}

export async function syncPriceReactions(): Promise<{ updated: number; failures: string[] }> {
  const today = istDate(new Date());
  const since = addDays(today, -LOOKBACK_DAYS);
  const events = await listEventsNeedingReaction(since);
  if (!events.length) return { updated: 0, failures: [] };

  const failures: string[] = [];
  const earliest = events.reduce((m, e) => (e.date < m ? e.date : m), today);
  const from = addDays(earliest, -10);

  try {
    await ensurePrices(NIFTY, from, today);
  } catch (err) {
    return { updated: 0, failures: [`NIFTY 50 prices: ${describeFetchError(err)}`] };
  }
  const index = await getPriceBars(NIFTY, from);

  const byTicker = new Map<string, MarketEvent[]>();
  for (const e of events) (byTicker.get(e.ticker) ?? byTicker.set(e.ticker, []).get(e.ticker)!).push(e);

  let updated = 0;
  for (const [ticker, evs] of byTicker) {
    const tFrom = addDays(evs.reduce((m, e) => (e.date < m ? e.date : m), today), -10);
    try {
      await ensurePrices(ticker, tFrom, today);
    } catch (err) {
      failures.push(`${ticker} prices: ${describeFetchError(err)}`);
      continue;
    }
    const bars = await getPriceBars(ticker, tFrom);
    for (const e of evs) {
      const r = computeReaction(bars, index, e.date, e.minutes);
      await upsertReaction({
        eventType: e.type, eventId: e.id, ticker, eventDate: e.date, label: e.label, category: e.category,
        baseDate: r.baseDate, ret1: r.ret[1], ret5: r.ret[5], ret20: r.ret[20],
        nifty1: r.nifty[1], nifty5: r.nifty[5], nifty20: r.nifty[20], complete: r.complete,
      });
      updated++;
    }
  }
  return { updated, failures };
}
