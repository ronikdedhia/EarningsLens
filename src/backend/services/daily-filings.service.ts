import axios from 'axios';
import { getBseCode, setBseCode, listCompanies } from './turso.service';

const BSE_API = 'https://api.bseindia.com/BseIndiaAPI/api';
const REFERER  = 'https://www.bseindia.com/';

const STATIC_BSE_CODES: Record<string, string> = {
  HDFCBANK:   '500180', ICICIBC:    '532174', ICICIBANK:  '532174',
  AXISBANK:   '532215', KOTAKBANK:  '500247', SBIN:       '500112',
  INFY:       '500209', TCS:        '532540', WIPRO:      '507685',
  RELIANCE:   '500325', BAJFINANCE: '500034',
};

export interface RawBseFiling {
  ticker:         string;
  bseCode:        string;
  attachmentName: string;
  title:          string;
  bseCategory:    string;
  filingDate:     string;   // ISO YYYY-MM-DD
  pdfUrl:         string;   // AttachLive or AttachHis URL
}

function formatBseDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseBseDate(raw: string): string {
  // BSE dates come as "YYYYMMDD" or "DD/MM/YYYY" or "YYYY-MM-DDTHH:MM:SS"
  if (!raw) return new Date().toISOString().slice(0, 10);
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
      headers: { Referer: REFERER },
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

async function fetchFilingsForCompany(
  ticker: string,
  bseCode: string,
  from: string,
  to: string,
): Promise<RawBseFiling[]> {
  const { data } = await axios.get(`${BSE_API}/AnnSubCategoryGetData/w`, {
    params: {
      strCat:      '-1',
      strPrevDate:  from,
      strScrip:     bseCode,
      strSearch:   'P',
      strToDate:    to,
      strType:     'C',
      subcategory: '-1',
    },
    headers: {
      Referer:    REFERER,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    timeout: 30_000,
  });

  const announcements: Array<{
    NEWSSUB?:        string;
    ATTACHMENTNAME?: string;
    CATEGORYNAME?:   string;
    AN_DT?:          string;
    DT_TM?:          string;
  }> = data?.Table ?? [];

  return announcements
    .filter(a => a.ATTACHMENTNAME?.endsWith('.pdf') || a.ATTACHMENTNAME?.endsWith('.PDF'))
    .map(a => {
      const name = a.ATTACHMENTNAME!;
      // Try AttachHis first (not Akamai-blocked); falls back to AttachLive at download time
      const pdfUrl = `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${name}`;
      return {
        ticker,
        bseCode,
        attachmentName: name,
        title:          (a.NEWSSUB ?? '').trim(),
        bseCategory:    (a.CATEGORYNAME ?? 'Other').trim(),
        filingDate:     parseBseDate(a.AN_DT ?? a.DT_TM ?? ''),
        pdfUrl,
      };
    });
}

export async function scrapeFilingsForDate(targetDate?: Date): Promise<RawBseFiling[]> {
  const to   = new Date(targetDate ?? Date.now());
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000); // 24h window

  const companies = await listCompanies();
  console.log(`[scrape] ${companies.length} companies, window: ${formatBseDate(from)} → ${formatBseDate(to)}`);
  const allFilings: RawBseFiling[] = [];

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    const bseCode = company.bseCode ?? await resolveBseCode(company.ticker);
    if (!bseCode) {
      console.log(`[scrape] (${i + 1}/${companies.length}) ${company.ticker} — no BSE code, skip`);
      continue;
    }
    try {
      const filings = await fetchFilingsForCompany(
        company.ticker, bseCode,
        formatBseDate(from), formatBseDate(to),
      );
      console.log(`[scrape] (${i + 1}/${companies.length}) ${company.ticker} (${bseCode}) → ${filings.length} filings`);
      allFilings.push(...filings);
    } catch (err) {
      console.log(`[scrape] (${i + 1}/${companies.length}) ${company.ticker} — ERROR: ${String(err).slice(0, 80)}`);
    }
  }

  console.log(`[scrape] total raw filings: ${allFilings.length}`);
  return allFilings;
}
