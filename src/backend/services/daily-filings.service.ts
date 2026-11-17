import axios from 'axios';
import { getBseCode, setBseCode, listCompanies } from './turso.service';
import { fetchNseAnnouncements, describeFetchError, istDate } from './nse.service';
import { STATIC_BSE_CODES } from '../watchlist';

const BSE_API = 'https://api.bseindia.com/BseIndiaAPI/api';
const REFERER  = 'https://www.bseindia.com/';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';


export interface RawBseFiling {
  ticker:         string;
  bseCode:        string;
  attachmentName: string;
  title:          string;
  bseCategory:    string;
  filingDate:     string;   // ISO YYYY-MM-DD
  pdfUrl:         string;   // NSE archive URL, or BSE AttachHis/AttachLive URL
  filedAt?:       string;   // "YYYY-MM-DD HH:MM:SS" IST when the exchange gives a time
}

export interface FetchFailure {
  ticker: string;
  error:  string;
}

export interface ScrapeResult {
  filings:   RawBseFiling[];
  failures:  FetchFailure[];   // companies where every source failed
  companies: number;           // companies attempted
}

function formatBseDate(d: Date): string {
  return istDate(d).replace(/-/g, '');
}

function parseBseDate(raw: string): string {
  // BSE dates come as "YYYYMMDD" or "DD/MM/YYYY" or "YYYY-MM-DDTHH:MM:SS"
  if (!raw) return istDate(new Date());
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{2}\/\d{2}\/\d{4}/.test(raw)) {
    const [d, m, y] = raw.split('/');
    return `${y}-${m}-${d}`;
  }
  return raw.slice(0, 10);
}

async function resolveBseCode(ticker: string): Promise<string | null> {
  const upper = ticker.toUpperCase();
  const cached = await getBseCode(upper);
  if (cached) return cached;
  if (STATIC_BSE_CODES[upper]) {
    await setBseCode(upper, STATIC_BSE_CODES[upper]);
    return STATIC_BSE_CODES[upper];
  }
  try {
    const { data } = await axios.get(`${BSE_API}/ListofScripData/w`, {
      params: { Group: '', Scripcode: '', shname: ticker, siccd: '', industry: '', status: 'Active' },
      headers: { Referer: REFERER, 'User-Agent': BROWSER_UA },
      timeout: 10_000,
    });
    const companies: Array<{ SCRIP_CD: string; NSCSYMBOL?: string }> = data?.Table ?? [];
    const hit = companies.find(c => c.NSCSYMBOL?.toUpperCase() === upper) ?? companies[0];
    if (!hit?.SCRIP_CD) return null;
    await setBseCode(upper, String(hit.SCRIP_CD));
    return String(hit.SCRIP_CD);
  } catch {
    return null;
  }
}

async function fetchNseFilings(ticker: string, bseCode: string, from: Date, to: Date): Promise<RawBseFiling[]> {
  const announcements = await fetchNseAnnouncements(ticker, from, to);
  return announcements.map(a => ({
    ticker,
    bseCode,
    attachmentName: a.pdfUrl.split('/').pop() ?? '',
    // NSE's category is short ("Cessation"); the text carries the substance.
    title:          a.text ? `${a.category}: ${a.text}` : a.category,
    bseCategory:    a.category,
    filingDate:     a.filingDate || istDate(to),
    pdfUrl:         a.pdfUrl,
    filedAt:        a.filedAt || undefined,
  }));
}

async function fetchBseFilings(ticker: string, bseCode: string, from: Date, to: Date): Promise<RawBseFiling[]> {
  const { data } = await axios.get(`${BSE_API}/AnnSubCategoryGetData/w`, {
    params: {
      strCat:      '-1',
      strPrevDate:  formatBseDate(from),
      strScrip:     bseCode,
      strSearch:   'P',
      strToDate:    formatBseDate(to),
      strType:     'C',
      subcategory: '-1',
    },
    headers: { Referer: REFERER, 'User-Agent': BROWSER_UA },
    timeout: 30_000,
  });

  // An Akamai block page is HTML, not JSON; treat it as a failure, not "no filings".
  if (!data || typeof data !== 'object' || !Array.isArray((data as { Table?: unknown }).Table)) {
    throw new Error('BSE returned a non-JSON response');
  }

  const announcements: Array<{
    NEWSSUB?:        string;
    ATTACHMENTNAME?: string;
    CATEGORYNAME?:   string;
    AN_DT?:          string;
    DT_TM?:          string;
  }> = (data as { Table: [] }).Table;

  return announcements
    .filter(a => a.ATTACHMENTNAME?.toLowerCase().endsWith('.pdf'))
    .map(a => {
      const name = a.ATTACHMENTNAME!;
      return {
        ticker,
        bseCode,
        attachmentName: name,
        title:          (a.NEWSSUB ?? '').trim(),
        bseCategory:    (a.CATEGORYNAME ?? 'Other').trim(),
        filingDate:     parseBseDate(a.AN_DT ?? a.DT_TM ?? ''),
        // AttachHis first; the graph falls back to AttachLive at download time
        pdfUrl:         `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${name}`,
      };
    });
}

/**
 * Filings for every tracked company over the 24h before `targetDate`.
 * NSE first, BSE API as a fallback. A company where both fail is reported in
 * `failures`, so "BSE is blocking us" is no longer indistinguishable from
 * "nobody filed anything today".
 */
export async function scrapeFilingsForDate(targetDate?: Date): Promise<ScrapeResult> {
  const to   = new Date(targetDate ?? Date.now());
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);

  const companies = await listCompanies();
  console.log(`[scrape] ${companies.length} companies, window: ${istDate(from)} → ${istDate(to)}`);
  const filings: RawBseFiling[] = [];
  const failures: FetchFailure[] = [];

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    const tag = `[scrape] (${i + 1}/${companies.length}) ${company.ticker}`;
    const bseCode = company.bseCode ?? await resolveBseCode(company.ticker) ?? '';

    try {
      const rows = await fetchNseFilings(company.ticker, bseCode, from, to);
      console.log(`${tag} NSE → ${rows.length} filings`);
      filings.push(...rows);
      continue;
    } catch (nseErr) {
      const nseMsg = `NSE ${describeFetchError(nseErr)}`;
      if (!bseCode) {
        console.log(`${tag} ${nseMsg}; no BSE code for fallback`);
        failures.push({ ticker: company.ticker, error: nseMsg });
        continue;
      }
      try {
        const rows = await fetchBseFilings(company.ticker, bseCode, from, to);
        console.log(`${tag} ${nseMsg}; BSE (${bseCode}) → ${rows.length} filings`);
        filings.push(...rows);
      } catch (bseErr) {
        const msg = `${nseMsg}; BSE ${describeFetchError(bseErr)}`;
        console.log(`${tag} ${msg}`);
        failures.push({ ticker: company.ticker, error: msg });
      }
    }
  }

  console.log(`[scrape] total raw filings: ${filings.length}, failed companies: ${failures.length}`);
  return { filings, failures, companies: companies.length };
}
