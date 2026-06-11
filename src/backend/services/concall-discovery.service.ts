import axios from 'axios';
import { getBseCode, setBseCode } from './turso.service';
import { discoverPdfUrlFromScreener } from './screener.service';

const BSE_API = 'https://api.bseindia.com/BseIndiaAPI/api';
const REFERER  = 'https://www.bseindia.com/';

// Fallback map for seeded companies — BSE's ListofScripData API is unreliable
const STATIC_BSE_CODES: Record<string, string> = {
  HDFCBANK:   '500180',
  ICICIBC:    '532174',
  ICICIBANK:  '532174',
  AXISBANK:   '532215',
  KOTAKBANK:  '500247',
  SBIN:       '500112',
  INFY:       '500209',
  TCS:        '532540',
  WIPRO:      '507685',
  RELIANCE:   '500325',
  BAJFINANCE: '500034',
};

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

export async function discoverPdfUrl(ticker: string, quarter: string): Promise<string | null> {
  // Primary: Screener.in → BSE AttachHis (not Akamai-blocked, works for all companies)
  try {
    const screenerUrl = await discoverPdfUrlFromScreener(ticker, quarter);
    if (screenerUrl) return screenerUrl;
  } catch {
    // fall through to BSE API
  }

  // Fallback: BSE announcement API → AttachLive (may be Akamai-blocked)
  const bseCode = await resolveBseCode(ticker);
  const { from, to } = quarterToAnnouncementRange(quarter);

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
  return `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${hit.ATTACHMENTNAME}`;
}
