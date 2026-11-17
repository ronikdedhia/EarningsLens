import axios from 'axios';
import { getBseCode, setBseCode } from './turso.service';
import { discoverPdfUrlFromScreener } from './screener.service';
import { fetchNseAnnouncements, type NseAnnouncement } from './nse.service';

const BSE_API = 'https://api.bseindia.com/BseIndiaAPI/api';
const REFERER  = 'https://www.bseindia.com/';

// Fallback map for watchlist companies — BSE's ListofScripData API is unreliable
import { STATIC_BSE_CODES } from '../watchlist';

// ── Quarter → calendar date range ─────────────────────────────────────────────
// Indian FY: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar
// "Q1FY26" → quarter ends Jun-30-2025; concall PDF appears July–September 2025

interface DateRange { from: string; to: string }

function quarterToAnnouncementRange(quarter: string): DateRange {
  const m = quarter.match(/^Q(\d)FY(\d{2,4})$/);
  if (!m) throw new Error(`Invalid quarter format: ${quarter}`);

  const q  = parseInt(m[1]);
  const fy = m[2].length === 2 ? 2000 + parseInt(m[2]) : parseInt(m[2]);

  // Quarter end date
  const endYear  = q === 4 ? fy     : fy - 1;
  const endMonth = [6, 9, 12, 3][q - 1];
  const endDay   = new Date(endYear, endMonth, 0).getDate(); // last day of month

  // PDFs appear 1–90 days after quarter end
  const fromDate = new Date(endYear, endMonth - 1, endDay + 1);
  const toDate   = new Date(endYear, endMonth - 1, endDay + 90);

  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

  return { from: fmt(fromDate), to: fmt(toDate) };
}

// ── BSE scrip code lookup (static map → Turso cache → BSE API) ───────────────

async function resolveBseCode(ticker: string): Promise<string> {
  const upper = ticker.toUpperCase();

  // 1. Turso cache
  const cached = await getBseCode(upper);
  if (cached) return cached;

  // 2. Static fallback map
  if (STATIC_BSE_CODES[upper]) {
    await setBseCode(upper, STATIC_BSE_CODES[upper]);
    return STATIC_BSE_CODES[upper];
  }

  // 3. BSE API (may not always work)
  const { data } = await axios.get(`${BSE_API}/ListofScripData/w`, {
    params: { Group: '', Scripcode: '', shname: ticker, siccd: '', industry: '', status: 'Active' },
    headers: { Referer: REFERER },
    timeout: 10_000,
  });

  const companies: Array<{ SCRIP_CD: string; NSCSYMBOL?: string; SCRIP_NAME?: string }> =
    data?.Table ?? [];

  const hit =
    companies.find(c => c.NSCSYMBOL?.toUpperCase() === upper) ??
    companies[0];

  if (!hit?.SCRIP_CD) throw new Error(`BSE scrip code not found for ${ticker}`);

  await setBseCode(upper, String(hit.SCRIP_CD));
  return String(hit.SCRIP_CD);
}

// ── Main: discover PDF URL for a ticker + quarter ────────────────────────────

// BSE uses "Analyst / Investor Meet - Outcome" for post-call transcripts
const CONCALL_KEYWORDS = [
  'concall', 'transcript', 'earnings call', 'investor call', 'con call',
  'analyst meet', 'analyst / investor meet - outcome', 'investor meet - outcome',
];

// The NSE category varies by company ("Analysts/Institutional Investor Meet/Con. Call
// Updates" for Shakti Pumps, plain "Updates" for Infosys), so match on the text.
export function isNseTranscript(a: Pick<NseAnnouncement, 'category' | 'text'>): boolean {
  const text = `${a.category} ${a.text}`.toLowerCase();
  return text.includes('transcript') && /\b(call|con\.? ?call|concall|conference)\b/.test(text)
    && !/\b(agm|annual general meeting)\b/.test(text);
}

function yyyymmddToDate(s: string): Date {
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T12:00:00+05:30`);
}

export interface DiscoveredTranscript {
  pdfUrl:   string;
  filedAt?: string;   // exchange broadcast time, "YYYY-MM-DD HH:MM:SS" IST; only NSE gives it
}

export async function discoverPdfUrl(ticker: string, quarter: string): Promise<DiscoveredTranscript | null> {
  const { from, to } = quarterToAnnouncementRange(quarter);

  // Primary: NSE announcements. Gives the exact filing time, which price
  // reactions to red flags are measured from.
  try {
    const announcements = await fetchNseAnnouncements(ticker, yyyymmddToDate(from), yyyymmddToDate(to));
    const hit = announcements
      .filter(isNseTranscript)
      .sort((a, b) => a.filedAt.localeCompare(b.filedAt))[0]; // the original, not a later corrected copy
    if (hit) return { pdfUrl: hit.pdfUrl, filedAt: hit.filedAt || undefined };
  } catch {
    // fall through
  }

  // Second: Screener.in → BSE AttachHis (no filing time)
  try {
    const screenerUrl = await discoverPdfUrlFromScreener(ticker, quarter);
    if (screenerUrl) return { pdfUrl: screenerUrl };
  } catch {
    // fall through to BSE API
  }

  // Last resort: BSE announcement API → AttachLive. Akamai blocks it (403), so a
  // failure here means "not found", not an error for the whole quarter.
  try {
    return await discoverFromBse(ticker, from, to);
  } catch {
    return null;
  }
}

async function discoverFromBse(ticker: string, from: string, to: string): Promise<DiscoveredTranscript | null> {
  const bseCode = await resolveBseCode(ticker);
  const { data } = await axios.get(`${BSE_API}/AnnGetData/w`, {
    params: {
      strCat:       '-1',
      strPrevDate:  from,
      strScrip:     bseCode,
      strSearch:    'P',
      strToDate:    to,
      strType:      'C',
      subcategory:  '-1',
    },
    headers: { Referer: REFERER },
    timeout: 15_000,
  });

  const announcements: Array<{ NEWSSUB?: string; ATTACHMENTNAME?: string }> =
    data?.Table ?? [];

  const hit = announcements.find(ann => {
    const subject = (ann.NEWSSUB ?? '').toLowerCase();
    return CONCALL_KEYWORDS.some(k => subject.includes(k)) && ann.ATTACHMENTNAME;
  });

  if (!hit?.ATTACHMENTNAME) return null;
  return { pdfUrl: `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${hit.ATTACHMENTNAME}` };
}
