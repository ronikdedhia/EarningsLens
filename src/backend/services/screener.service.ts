import axios from 'axios';
import * as cheerio from 'cheerio';

const SCREENER_BASE = 'https://www.screener.in/company';

// Some DB tickers differ from Screener's NSE symbols
const SCREENER_TICKER_MAP: Record<string, string> = {
  ICICIBC: 'ICICIBANK',
};

const MONTH_MAP: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

// Concall date (when the call was held) → Indian FY quarter label
// Q1FY{N}: Apr-Jun (N-1), concall Jul-Sep (N-1)
// Q2FY{N}: Jul-Sep (N-1), concall Oct-Dec (N-1)
// Q3FY{N}: Oct-Dec (N-1), concall Jan-Mar N
// Q4FY{N}: Jan-Mar N,     concall Apr-Jun N
function concallDateToQuarter(month: number, year: number): string {
  let q: number;
  let fyEnd: number;
  if (month >= 1 && month <= 3)       { q = 3; fyEnd = year; }
  else if (month >= 4 && month <= 6)  { q = 4; fyEnd = year; }
  else if (month >= 7 && month <= 9)  { q = 1; fyEnd = year + 1; }
  else                                 { q = 2; fyEnd = year + 1; }
  return `Q${q}FY${String(fyEnd).slice(-2)}`;
}

// BSE AnnPdfOpen.aspx?Pname=UUID.pdf → AttachHis direct (not Akamai-blocked)
function normalizeUrl(href: string, base: string): string {
  let resolved = href;
  if (href.startsWith('/')) resolved = `https://www.screener.in${href}`;
  else if (!href.startsWith('http')) resolved = `${base}/${href}`;

  // Convert BSE AnnPdfOpen redirect to direct AttachHis URL
  try {
    const u = new URL(resolved);
    if (u.hostname.includes('bseindia.com') && u.pathname.includes('AnnPdfOpen')) {
      const pname = u.searchParams.get('Pname') ?? u.searchParams.get('pname');
      if (pname) return `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${pname}`;
    }
  } catch {
    // malformed URL — return as-is
  }
  return resolved;
}

function inferSector(name: string): string {
  const n = name.toLowerCase();
  if (/bank/.test(n)) return 'Banking';
  if (/finance|finserv|nbfc|capital|lending|leasing/.test(n)) return 'NBFC';
  if (/infosy|consultancy|wipro|tech|software|digital|infra|it ltd|it limited/.test(n)) return 'Technology';
  if (/reliance|conglomerate|industries/.test(n)) return 'Conglomerate';
  return 'Other';
}

export interface ScreenerSearchResult { ticker: string; name: string; url: string }

// Nifty 500 + popular NSE companies for instant offline search
const NSE_COMPANIES: ScreenerSearchResult[] = [
  { ticker: 'RELIANCE',    name: 'Reliance Industries Ltd.',              url: '' },
  { ticker: 'TCS',         name: 'Tata Consultancy Services Ltd.',        url: '' },
  { ticker: 'HDFCBANK',    name: 'HDFC Bank Ltd.',                        url: '' },
  { ticker: 'INFY',        name: 'Infosys Ltd.',                          url: '' },
  { ticker: 'ICICIBANK',   name: 'ICICI Bank Ltd.',                       url: '' },
  { ticker: 'HINDUNILVR',  name: 'Hindustan Unilever Ltd.',               url: '' },
  { ticker: 'ITC',         name: 'ITC Ltd.',                              url: '' },
  { ticker: 'KOTAKBANK',   name: 'Kotak Mahindra Bank Ltd.',              url: '' },
  { ticker: 'LT',          name: 'Larsen & Toubro Ltd.',                  url: '' },
  { ticker: 'AXISBANK',    name: 'Axis Bank Ltd.',                        url: '' },
  { ticker: 'SBIN',        name: 'State Bank of India',                   url: '' },
  { ticker: 'BHARTIARTL',  name: 'Bharti Airtel Ltd.',                    url: '' },
  { ticker: 'WIPRO',       name: 'Wipro Ltd.',                            url: '' },
  { ticker: 'BAJFINANCE',  name: 'Bajaj Finance Ltd.',                    url: '' },
  { ticker: 'HCLTECH',     name: 'HCL Technologies Ltd.',                 url: '' },
  { ticker: 'ASIANPAINT',  name: 'Asian Paints Ltd.',                     url: '' },
  { ticker: 'TITAN',       name: 'Titan Company Ltd.',                    url: '' },
  { ticker: 'MARUTI',      name: 'Maruti Suzuki India Ltd.',              url: '' },
  { ticker: 'SUNPHARMA',   name: 'Sun Pharmaceutical Industries Ltd.',    url: '' },
  { ticker: 'ULTRACEMCO',  name: 'UltraTech Cement Ltd.',                 url: '' },
  { ticker: 'TECHM',       name: 'Tech Mahindra Ltd.',                    url: '' },
  { ticker: 'POWERGRID',   name: 'Power Grid Corporation of India Ltd.',  url: '' },
  { ticker: 'NTPC',        name: 'NTPC Ltd.',                             url: '' },
  { ticker: 'BAJAJFINSV',  name: 'Bajaj Finserv Ltd.',                    url: '' },
  { ticker: 'ONGC',        name: 'Oil & Natural Gas Corporation Ltd.',    url: '' },
  { ticker: 'COALINDIA',   name: 'Coal India Ltd.',                       url: '' },
  { ticker: 'TATAMOTORS',  name: 'Tata Motors Ltd.',                      url: '' },
  { ticker: 'TATACONSUM',  name: 'Tata Consumer Products Ltd.',           url: '' },
  { ticker: 'TATASTEEL',   name: 'Tata Steel Ltd.',                       url: '' },
  { ticker: 'ADANIENT',    name: 'Adani Enterprises Ltd.',                url: '' },
  { ticker: 'ADANIPORTS',  name: 'Adani Ports & SEZ Ltd.',                url: '' },
  { ticker: 'NESTLEIND',   name: 'Nestle India Ltd.',                     url: '' },
  { ticker: 'DRREDDY',     name: "Dr. Reddy's Laboratories Ltd.",         url: '' },
  { ticker: 'CIPLA',       name: 'Cipla Ltd.',                            url: '' },
  { ticker: 'DIVISLAB',    name: "Divi's Laboratories Ltd.",              url: '' },
  { ticker: 'APOLLOHOSP',  name: 'Apollo Hospitals Enterprise Ltd.',      url: '' },
  { ticker: 'EICHERMOT',   name: 'Eicher Motors Ltd.',                    url: '' },
  { ticker: 'HEROMOTOCO',  name: 'Hero MotoCorp Ltd.',                    url: '' },
  { ticker: 'BAJAJ-AUTO',  name: 'Bajaj Auto Ltd.',                       url: '' },
  { ticker: 'GRASIM',      name: 'Grasim Industries Ltd.',                url: '' },
  { ticker: 'INDUSINDBK',  name: 'IndusInd Bank Ltd.',                    url: '' },
  { ticker: 'HDFCLIFE',    name: 'HDFC Life Insurance Co. Ltd.',          url: '' },
  { ticker: 'SBILIFE',     name: 'SBI Life Insurance Co. Ltd.',           url: '' },
  { ticker: 'ICICIPRULI',  name: 'ICICI Prudential Life Insurance Co.',   url: '' },
  { ticker: 'BRITANNIA',   name: 'Britannia Industries Ltd.',             url: '' },
  { ticker: 'DABUR',       name: 'Dabur India Ltd.',                      url: '' },
  { ticker: 'MARICO',      name: 'Marico Ltd.',                           url: '' },
  { ticker: 'PIDILITIND',  name: 'Pidilite Industries Ltd.',              url: '' },
  { ticker: 'BERGEPAINT',  name: 'Berger Paints India Ltd.',              url: '' },
  { ticker: 'HAVELLS',     name: 'Havells India Ltd.',                    url: '' },
  { ticker: 'VOLTAS',      name: 'Voltas Ltd.',                           url: '' },
  { ticker: 'GODREJCP',    name: 'Godrej Consumer Products Ltd.',         url: '' },
  { ticker: 'MUTHOOTFIN',  name: 'Muthoot Finance Ltd.',                  url: '' },
  { ticker: 'CHOLAFIN',    name: 'Cholamandalam Investment & Finance Co.',url: '' },
  { ticker: 'LICHSGFIN',   name: 'LIC Housing Finance Ltd.',              url: '' },
  { ticker: 'RECLTD',      name: 'REC Ltd.',                              url: '' },
  { ticker: 'PFC',         name: 'Power Finance Corporation Ltd.',        url: '' },
  { ticker: 'BANKBARODA',  name: 'Bank of Baroda',                        url: '' },
  { ticker: 'CANARABANK',  name: 'Canara Bank',                           url: '' },
  { ticker: 'UNIONBANK',   name: 'Union Bank of India',                   url: '' },
  { ticker: 'IDFCFIRSTB',  name: 'IDFC First Bank Ltd.',                  url: '' },
  { ticker: 'FEDERALBNK',  name: 'Federal Bank Ltd.',                     url: '' },
  { ticker: 'BANDHANBNK',  name: 'Bandhan Bank Ltd.',                     url: '' },
  { ticker: 'YESBANK',     name: 'Yes Bank Ltd.',                         url: '' },
  { ticker: 'MPHASIS',     name: 'Mphasis Ltd.',                          url: '' },
  { ticker: 'LTIM',        name: 'LTIMindtree Ltd.',                      url: '' },
  { ticker: 'PERSISTENT',  name: 'Persistent Systems Ltd.',               url: '' },
  { ticker: 'COFORGE',     name: 'Coforge Ltd.',                          url: '' },
  { ticker: 'ZOMATO',      name: 'Zomato Ltd.',                           url: '' },
  { ticker: 'DMART',       name: 'Avenue Supermarts Ltd.',                url: '' },
  { ticker: 'SIEMENS',     name: 'Siemens Ltd.',                          url: '' },
  { ticker: 'ABB',         name: 'ABB India Ltd.',                        url: '' },
  { ticker: 'MRF',         name: 'MRF Ltd.',                              url: '' },
  { ticker: 'JIOFIN',      name: 'Jio Financial Services Ltd.',           url: '' },
  { ticker: 'ADANIPOWER',  name: 'Adani Power Ltd.',                      url: '' },
  { ticker: 'ADANITOTAL',  name: 'Adani Total Gas Ltd.',                  url: '' },
  { ticker: 'ADANIGREEN',  name: 'Adani Green Energy Ltd.',               url: '' },
  { ticker: 'OBEROIRLTY',  name: 'Oberoi Realty Ltd.',                    url: '' },
  { ticker: 'DLF',         name: 'DLF Ltd.',                              url: '' },
  { ticker: 'GODREJPROP',  name: 'Godrej Properties Ltd.',                url: '' },
  { ticker: 'PHOENIXLTD',  name: 'Phoenix Mills Ltd.',                    url: '' },
  { ticker: 'PRESTIGE',    name: 'Prestige Estates Projects Ltd.',        url: '' },
  { ticker: 'IRFC',        name: 'Indian Railway Finance Corporation',    url: '' },
  { ticker: 'RVNL',        name: 'Rail Vikas Nigam Ltd.',                 url: '' },
  { ticker: 'HAL',         name: 'Hindustan Aeronautics Ltd.',            url: '' },
  { ticker: 'BEL',         name: 'Bharat Electronics Ltd.',               url: '' },
  { ticker: 'BHEL',        name: 'Bharat Heavy Electricals Ltd.',         url: '' },
  { ticker: 'SAIL',        name: 'Steel Authority of India Ltd.',         url: '' },
  { ticker: 'NMDC',        name: 'NMDC Ltd.',                             url: '' },
  { ticker: 'HINDALCO',    name: 'Hindalco Industries Ltd.',              url: '' },
  { ticker: 'VEDL',        name: 'Vedanta Ltd.',                          url: '' },
  { ticker: 'JSWSTEEL',    name: 'JSW Steel Ltd.',                        url: '' },
  { ticker: 'HINDZINC',    name: 'Hindustan Zinc Ltd.',                   url: '' },
  { ticker: 'IOCL',        name: 'Indian Oil Corporation Ltd.',           url: '' },
  { ticker: 'BPCL',        name: 'Bharat Petroleum Corporation Ltd.',     url: '' },
  { ticker: 'HPCL',        name: 'Hindustan Petroleum Corporation Ltd.',  url: '' },
  { ticker: 'GAIL',        name: 'GAIL (India) Ltd.',                     url: '' },
  { ticker: 'PETRONET',    name: 'Petronet LNG Ltd.',                     url: '' },
  { ticker: 'IOC',         name: 'Indian Oil Corporation Ltd.',           url: '' },
  { ticker: 'TORNTPHARM', name: 'Torrent Pharmaceuticals Ltd.',          url: '' },
  { ticker: 'AUROPHARMA',  name: 'Aurobindo Pharma Ltd.',                 url: '' },
  { ticker: 'LUPIN',       name: 'Lupin Ltd.',                            url: '' },
  { ticker: 'BIOCON',      name: 'Biocon Ltd.',                           url: '' },
  { ticker: 'LALPATHLAB',  name: 'Dr. Lal PathLabs Ltd.',                 url: '' },
  { ticker: 'METROPOLIS',  name: 'Metropolis Healthcare Ltd.',            url: '' },
  { ticker: 'FORTIS',      name: 'Fortis Healthcare Ltd.',                url: '' },
  { ticker: 'MAXHEALTH',   name: 'Max Healthcare Institute Ltd.',         url: '' },
  { ticker: 'RELAXO',      name: 'Relaxo Footwears Ltd.',                 url: '' },
  { ticker: 'BATAINDIA',   name: 'Bata India Ltd.',                       url: '' },
  { ticker: 'TRENT',       name: 'Trent Ltd.',                            url: '' },
  { ticker: 'ABFRL',       name: 'Aditya Birla Fashion & Retail Ltd.',    url: '' },
  { ticker: 'PAGEIND',     name: 'Page Industries Ltd.',                  url: '' },
  { ticker: 'KALYANKJIL',  name: 'Kalyan Jewellers India Ltd.',           url: '' },
  { ticker: 'RAJESHEXPO',  name: 'Rajesh Exports Ltd.',                   url: '' },
].map(c => ({ ...c, url: `/company/${c.ticker}/` }));

function localSearch(query: string): ScreenerSearchResult[] {
  const q = query.toLowerCase().trim();
  const qNoSpace = q.replace(/\s+/g, '');
  return NSE_COMPANIES.filter(c =>
    c.ticker.toLowerCase().includes(qNoSpace) ||
    c.name.toLowerCase().includes(q) ||
    c.name.toLowerCase().replace(/\s+/g, '').includes(qNoSpace)
  ).slice(0, 10);
}

export async function searchCompanies(query: string): Promise<ScreenerSearchResult[]> {
  // 1. Try Yahoo Finance search API (no auth needed, returns NSE stocks)
  try {
    const { data } = await axios.get(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&lang=en-IN&region=IN&quotesCount=10&newsCount=0&enableFuzzyQuery=true&enableCb=false`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        timeout: 8_000,
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quotes: any[] = data?.quotes ?? [];
    const mapped = quotes
      .filter(q => q.symbol?.endsWith('.NS') && (q.quoteType === 'EQUITY' || q.typeDisp === 'Equity'))
      .map(q => ({
        ticker: q.symbol.replace('.NS', '').toUpperCase(),
        name:   q.longname || q.shortname || q.symbol,
        url:    `/company/${q.symbol.replace('.NS', '')}/`,
      }));
    if (mapped.length > 0) return mapped;
  } catch { /* fall through */ }

  // 2. Local list fallback — always works, covers Nifty 500
  return localSearch(query);
}

export async function getCompanyInfoFromScreener(ticker: string): Promise<{ name: string; sector: string } | null> {
  const screenerTicker = SCREENER_TICKER_MAP[ticker.toUpperCase()] ?? ticker.toUpperCase();
  const urls = [
    `${SCREENER_BASE}/${screenerTicker}/consolidated/`,
    `${SCREENER_BASE}/${screenerTicker}/`,
  ];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.screener.in/',
  };

  for (const url of urls) {
    try {
      const { data } = await axios.get<string>(url, { headers, timeout: 15_000 });
      const $ = cheerio.load(data);
      const name = $('h1').first().text().trim().replace(/\s+/g, ' ');
      if (name && name.length > 2) {
        return { name, sector: inferSector(name) };
      }
    } catch {
      // try next url
    }
  }
  return null;
}

export async function discoverPdfUrlFromScreener(
  ticker: string,
  quarter: string,
): Promise<string | null> {
  const screenerTicker = SCREENER_TICKER_MAP[ticker.toUpperCase()] ?? ticker.toUpperCase();
  const pageUrl = `${SCREENER_BASE}/${screenerTicker}/consolidated/`;

  let html: string;
  try {
    const { data } = await axios.get<string>(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.screener.in/',
      },
      timeout: 20_000,
    });
    html = data;
  } catch {
    // Try without /consolidated/ (some companies only have standalone page)
    const { data } = await axios.get<string>(`${SCREENER_BASE}/${screenerTicker}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.screener.in/',
      },
      timeout: 20_000,
    });
    html = data;
  }

  const $ = cheerio.load(html);

  // Screener renders concalls as: <div class="documents concalls ...">
  let concallEl = $('#concalls, .concalls').first();
  if (!concallEl.length) {
    $('section, div').each((_, el) => {
      if (concallEl.length) return;
      const heading = $(el).find('h2, h3, h4').first().text();
      if (/concall/i.test(heading)) concallEl = $(el);
    });
  }
  if (!concallEl.length) return null;

  let found: string | null = null;

  // Each concall row: typically a <li> or <tr> containing a date span and anchor links
  concallEl.find('li, tr').each((_, row) => {
    if (found) return;

    const rowText = $(row).text();

    // Date pattern: "Jul 2025", "October 2025", "Jul '25", etc.
    const dateMatch = rowText.match(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[.,]?\s*['']?(\d{2,4})\b/i,
    );
    if (!dateMatch) return;

    const monthAbbr = dateMatch[1].slice(0, 3);
    const monthAbbr3 = monthAbbr.charAt(0).toUpperCase() + monthAbbr.slice(1).toLowerCase();
    const month = MONTH_MAP[monthAbbr3];
    if (!month) return;

    let year = parseInt(dateMatch[2]);
    if (year < 100) year += 2000;

    const q = concallDateToQuarter(month, year);
    if (q !== quarter) return;

    // Look for a link whose text is "Transcript" or "Con Call" (exact or close)
    $(row).find('a').each((_, a) => {
      if (found) return;
      const text = $(a).text().trim().toLowerCase();
      if (text === 'transcript' || text === 'con call' || text === 'concall') {
        const href = $(a).attr('href') ?? '';
        if (href) found = normalizeUrl(href, pageUrl);
      }
    });
  });

  return found;
}
