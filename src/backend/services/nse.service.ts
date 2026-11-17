import axios from 'axios';

// NSE JSON endpoints behind nseindia.com's own pages. Checked 2026-11-17 from an
// Indian connection: plain browser headers, no cookie handshake. www.nseindia.com
// 301-redirects to www.nseindia.in, which axios follows.
//
// This replaced api.bseindia.com as the primary source: BSE's API answers every
// request with an Akamai "Access Denied" 403, while BSE PDFs still download.
const NSE_API = 'https://www.nseindia.com/api';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── Throttled client ──────────────────────────────────────────────────────────
// NSE's archive refuses a client that asks too fast, for minutes and for every
// NSE host at once. All NSE traffic goes through one queue with a gap between calls.

const MIN_GAP_MS = 400;
let chain: Promise<void> = Promise.resolve();
let lastCall = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
  });
  chain = run.catch(() => {});
  return run.then(fn);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await throttled(fn);
    } catch (err) {
      lastErr = err;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      // 404 is an answer, not a blip
      if (status && status < 500 && status !== 429) break;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function nseGet<T = unknown>(path: string, params: Record<string, string | number>): Promise<T> {
  return withRetry(async () => {
    const { data } = await axios.get(`${NSE_API}/${path}`, { params, headers: HEADERS, timeout: 30_000 });
    if (typeof data === 'string') throw new Error(`NSE ${path} returned HTML instead of JSON`);
    return data as T;
  });
}

/** Files on nsearchives (XBRL, XML). */
export async function nseArchiveText(url: string): Promise<string> {
  return withRetry(async () => {
    const { data } = await axios.get<string>(url, {
      headers: { ...HEADERS, Accept: '*/*' }, timeout: 45_000, responseType: 'text',
    });
    return data;
  });
}

// ── Dates (always India time) ─────────────────────────────────────────────────

/** YYYY-MM-DD for the calendar day in India, whatever timezone the server runs in. */
export function istDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Date as DD-MM-YYYY in India time, the format NSE's from/to params expect. */
export function nseDate(d: Date): string {
  const [y, m, day] = istDate(d).split('-');
  return `${day}-${m}-${y}`;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-11-17" → Date at noon IST that day (safe to pass to nseDate). */
export function istNoon(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00+05:30`);
}

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

export interface NseDateTime {
  date: string;              // YYYY-MM-DD
  minutes: number | null;    // minutes after midnight IST, null when no time given
}

/**
 * Parses the date formats NSE mixes across endpoints:
 * "09-Nov-2026 17:58:09", "23-FEB-2026", "2026-11-09 17:58:09", "31-Mar-2021, 18-38", "2026-11-13".
 */
export function parseNseDateTime(raw: string | null | undefined): NseDateTime | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, minutes: m[4] ? +m[4] * 60 + +m[5] : null };
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:,?\s+(\d{1,2})[:-](\d{2}))?/);
  if (m && MONTHS[m[2].toUpperCase()]) {
    return {
      date: `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}`,
      minutes: m[4] ? +m[4] * 60 + +m[5] : null,
    };
  }
  return null;
}

/** NSE cash market closes 15:30 IST. */
export const MARKET_CLOSE_MINUTES = 15 * 60 + 30;

// ── Corporate announcements ───────────────────────────────────────────────────

export interface NseAnnouncement {
  symbol:      string;
  category:    string;  // NSE "desc", e.g. "Cessation", "Outcome of Board Meeting"
  text:        string;  // NSE "attchmntText", the one-paragraph description
  pdfUrl:      string;
  filingDate:  string;  // YYYY-MM-DD
  filedAt:     string;  // "YYYY-MM-DD HH:MM:SS" IST, as NSE reports it
}

interface RawNseAnnouncement {
  symbol?:       string;
  desc?:         string;
  attchmntText?: string;
  attchmntFile?: string;
  sort_date?:    string;
  an_dt?:        string;
}

/** "2026-11-09 17:58:09" or "09-Nov-2026 17:58:09" → "2026-11-09". */
export function parseNseDate(raw: RawNseAnnouncement): string {
  return parseNseDateTime(raw.sort_date)?.date ?? parseNseDateTime(raw.an_dt)?.date ?? '';
}

export function parseNseAnnouncements(data: unknown, symbol: string): NseAnnouncement[] {
  if (!Array.isArray(data)) {
    throw new Error(`NSE returned ${data === null ? 'null' : typeof data}, expected an array`);
  }
  return (data as RawNseAnnouncement[])
    .filter(a => /\.pdf$/i.test(a.attchmntFile ?? ''))
    .map(a => ({
      symbol:     (a.symbol ?? symbol).toUpperCase(),
      category:   (a.desc ?? 'Other').trim(),
      text:       (a.attchmntText ?? '').replace(/\s+/g, ' ').trim(),
      pdfUrl:     a.attchmntFile!.trim(),
      filingDate: parseNseDate(a),
      filedAt:    (a.sort_date ?? '').trim(),
    }));
}

export async function fetchNseAnnouncements(symbol: string, from: Date, to: Date): Promise<NseAnnouncement[]> {
  const data = await nseGet('corporate-announcements', {
    index: 'equities', symbol, from_date: nseDate(from), to_date: nseDate(to),
  });
  return parseNseAnnouncements(data, symbol);
}

/** "Request failed with status code 403" → "HTTP 403"; keeps other messages short. */
export function describeFetchError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.response?.status) return `HTTP ${err.response.status}`;
    if (err.code) return err.code;
  }
  return String((err as Error)?.message ?? err).slice(0, 80);
}

// ── Board meetings ────────────────────────────────────────────────────────────

export interface NseBoardMeeting {
  symbol:      string;
  meetingDate: string;   // YYYY-MM-DD
  purpose:     string;
  description: string;
  isResults:   boolean;
}

export function parseBoardMeetings(data: unknown, symbol: string): NseBoardMeeting[] {
  if (!Array.isArray(data)) throw new Error('NSE board meetings: expected an array');
  return (data as Array<Record<string, string>>)
    .map(r => {
      const date = parseNseDateTime(r.bm_date)?.date ?? '';
      const purpose = (r.bm_purpose ?? '').trim();
      const description = (r.bm_desc ?? '').replace(/\s+/g, ' ').trim();
      return {
        symbol: (r.bm_symbol ?? symbol).toUpperCase(),
        meetingDate: date,
        purpose,
        description,
        isResults: /financial results?|results/i.test(`${purpose} ${description}`),
      };
    })
    .filter(m => m.meetingDate);
}

export async function fetchBoardMeetings(symbol: string, from: Date, to: Date): Promise<NseBoardMeeting[]> {
  const data = await nseGet('corporate-board-meetings', {
    index: 'equities', symbol, from_date: nseDate(from), to_date: nseDate(to),
  });
  return parseBoardMeetings(data, symbol);
}

// ── Prices ────────────────────────────────────────────────────────────────────

export interface DailyBar {
  date:      string;   // YYYY-MM-DD
  close:     number;
  prevClose: number;   // NSE's previous close, already adjusted on ex-dates
}

const SERIES_RANK: Record<string, number> = { EQ: 0, BE: 1, BZ: 2, SM: 3, ST: 4 };

/** One bar per date; prefers the EQ series when a stock trades in several. */
export function parseSecurityHistory(data: unknown): DailyBar[] {
  const rows = (data as { data?: unknown })?.data;
  if (!Array.isArray(rows)) throw new Error('NSE price history: expected data[]');
  const best = new Map<string, { rank: number; bar: DailyBar }>();
  for (const r of rows as Array<Record<string, unknown>>) {
    const date = parseNseDateTime(String(r.mTIMESTAMP ?? ''))?.date;
    const close = Number(r.CH_CLOSING_PRICE);
    const prevClose = Number(r.CH_PREVIOUS_CLS_PRICE);
    if (!date || !(close > 0) || !(prevClose > 0)) continue;
    const rank = SERIES_RANK[String(r.CH_SERIES)] ?? 9;
    const cur = best.get(date);
    if (!cur || rank < cur.rank) best.set(date, { rank, bar: { date, close, prevClose } });
  }
  return [...best.values()].map(v => v.bar).sort((a, b) => a.date.localeCompare(b.date));
}

export function parseIndexCloses(data: unknown): Array<{ date: string; close: number }> {
  const rows = (data as { data?: unknown })?.data;
  if (!Array.isArray(rows)) throw new Error('NSE index history: expected data[]');
  return (rows as Array<Record<string, unknown>>)
    .map(r => ({ date: parseNseDateTime(String(r.EOD_TIMESTAMP ?? ''))?.date ?? '', close: Number(r.EOD_CLOSE_INDEX_VAL) }))
    .filter(b => b.date && b.close > 0);
}

/** Index history has no previous-close column; indices don't split, so chain closes. */
export function chainCloses(closes: Array<{ date: string; close: number }>): DailyBar[] {
  const sorted = [...new Map(closes.map(c => [c.date, c])).values()].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.slice(1).map((b, i) => ({ date: b.date, close: b.close, prevClose: sorted[i].close }));
}

export const NIFTY = 'NIFTY 50';

/** Daily bars for a stock (or NIFTY 50) between two ISO dates, fetched in 60-day pieces. */
export async function fetchDailyBars(symbol: string, fromIso: string, toIso: string): Promise<DailyBar[]> {
  const isIndex = symbol === NIFTY;
  const stockBars: DailyBar[] = [];
  const indexCloses: Array<{ date: string; close: number }> = [];
  // The index needs a few days before `from` so the first bar has a previous close.
  let start = isIndex ? addDays(fromIso, -10) : fromIso;
  while (start <= toIso) {
    const end = addDays(start, 59) < toIso ? addDays(start, 59) : toIso;
    const params = { from: nseDate(istNoon(start)), to: nseDate(istNoon(end)) };
    if (isIndex) {
      indexCloses.push(...parseIndexCloses(await nseGet('historicalOR/indicesHistory', { indexType: NIFTY, ...params })));
    } else {
      stockBars.push(...parseSecurityHistory(await nseGet('historicalOR/generateSecurityWiseHistoricalData', {
        symbol, type: 'priceVolumeDeliverable', series: 'ALL', ...params,
      })));
    }
    start = addDays(end, 1);
  }
  const bars = isIndex ? chainCloses(indexCloses) : stockBars;
  const byDate = new Map(bars.map(b => [b.date, b]));
  return [...byDate.values()].filter(b => b.date >= fromIso).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Financial results (Integrated Filing) ─────────────────────────────────────
// Periods ending 31-Mar-2025 onward are filed as "Integrated Filing (Financials)";
// the older corporates-financial-results endpoint stops at Dec-2024.

export interface NseResultFiling {
  seqId:     number;
  symbol:    string;
  periodEnd: string;   // YYYY-MM-DD
  basis:     'Consolidated' | 'Standalone';
  audited:   string;
  revision:  boolean;
  filedAt:   string;   // "YYYY-MM-DD HH:MM" IST
  xbrlUrl:   string;
}

export function parseResultFilings(data: unknown): NseResultFiling[] {
  const rows = (data as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return []; // NSE answers {data: 0, msg: "no data found"}
  return (rows as Array<Record<string, string>>)
    .map(r => {
      const filed = parseNseDateTime(r.broadcast_Date) ?? parseNseDateTime(r.creation_Date);
      const minutes = filed?.minutes;
      return {
        seqId:     Number(r.seq_Id),
        symbol:    String(r.symbol ?? '').toUpperCase(),
        periodEnd: parseNseDateTime(r.qe_Date)?.date ?? '',
        basis:     (/consolidated/i.test(r.consolidated ?? '') ? 'Consolidated' : 'Standalone') as NseResultFiling['basis'],
        audited:   r.audited ?? '',
        revision:  /revision/i.test(r.type_Sub ?? ''),
        filedAt:   filed ? `${filed.date} ${minutes == null ? '' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`}`.trim() : '',
        xbrlUrl:   r.xbrl ?? '',
      };
    })
    .filter(f => f.seqId > 0 && f.periodEnd && /\.xml$/i.test(f.xbrlUrl));
}

export async function fetchResultFilings(symbol: string): Promise<NseResultFiling[]> {
  const data = await nseGet('integrated-filing-results', {
    index: 'equities', type: 'Integrated Filing- Financials', symbol, page: 1, size: 100,
  });
  return parseResultFilings(data);
}

// ── Insider trading (PIT Reg 7) ───────────────────────────────────────────────
// The old corporates-pit endpoint now always returns an empty list.

export interface NseInsiderFiling {
  appId:      string;
  symbol:     string;
  broadcast:  string;   // raw NSE timestamp
  revision:   boolean;
  xmlUrl:     string;
}

export function parseInsiderFilings(data: unknown): NseInsiderFiling[] {
  const rows = (data as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  return (rows as Array<Record<string, string>>)
    .map(r => ({
      appId:     String(r.appId ?? ''),
      symbol:    String(r.symbol ?? '').toUpperCase(),
      broadcast: r.broadcastDateTime ?? r.exchdisstime ?? '',
      revision:  /revision/i.test(r.typeOfSubmission ?? ''),
      xmlUrl:    r.xmlFileName ?? '',
    }))
    .filter(f => f.appId && /\.xml$/i.test(f.xmlUrl));
}

export async function fetchInsiderFilings(symbol: string, from: Date, to: Date): Promise<NseInsiderFiling[]> {
  const data = await nseGet('corporates-pit-gg', {
    index: 'equities', symbol, from_date: nseDate(from), to_date: nseDate(to),
  });
  return parseInsiderFilings(data);
}

// ── SAST Reg 29, pledges, bulk/block deals ────────────────────────────────────

export async function fetchSastReg29(symbol: string): Promise<Array<Record<string, string | null>>> {
  const data = await nseGet<{ data?: unknown }>('corporate-sast-reg29', { index: 'equities', symbol });
  return Array.isArray(data?.data) ? data.data as Array<Record<string, string | null>> : [];
}

export async function fetchPledgeData(symbol: string): Promise<Array<Record<string, string | null>>> {
  const data = await nseGet<{ data?: unknown }>('corporate-pledgedata', { index: 'equities', symbol });
  return Array.isArray(data?.data) ? data.data as Array<Record<string, string | null>> : [];
}

export async function fetchLargeDeals(
  kind: 'bulk_deals' | 'block_deals', symbol: string, from: Date, to: Date,
): Promise<Array<Record<string, string | number | null>>> {
  const data = await nseGet<{ data?: unknown }>('historicalOR/bulk-block-short-deals', {
    optionType: kind, symbol, from: nseDate(from), to: nseDate(to),
  });
  return Array.isArray(data?.data) ? data.data as Array<Record<string, string | number | null>> : [];
}
