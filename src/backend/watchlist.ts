// The tracked companies. scripts/init-db.ts seeds these, and
// scripts/update-watchlist.ts adds/removes the database rows to match.
// NSE symbols checked against NSE's announcements API, BSE codes from Screener (2026-11-17).

export interface WatchlistCompany {
  ticker:  string;   // NSE symbol
  name:    string;
  sector:  string;
  bseCode: string;
  // US FDA identities, for the pharma names. Checked against openFDA 2026-11-17.
  fda?: {
    sponsors: string[];   // openFDA drugsfda sponsor_name phrases (approvals)
    firms:    string[];   // openFDA enforcement recalling_firm phrases (recalls)
  };
}

export const WATCHLIST: WatchlistCompany[] = [
  { ticker: 'WOCKPHARMA', name: 'Wockhardt Ltd.',                     sector: 'Pharma',          bseCode: '532300',
    fda: { sponsors: ['WOCKHARDT'], firms: ['Wockhardt'] } },
  { ticker: 'IONEXCHANG', name: 'Ion Exchange (India) Ltd.',          sector: 'Water Treatment', bseCode: '500213' },
  { ticker: 'TRUALT',     name: 'TruAlt Bioenergy Ltd.',              sector: 'Energy',          bseCode: '544545' },
  // Morepen makes APIs (no ANDAs in openFDA); its FDA news comes from NSE filings.
  { ticker: 'MOREPENLAB', name: 'Morepen Laboratories Ltd.',          sector: 'Pharma',          bseCode: '500288',
    fda: { sponsors: [], firms: ['Morepen'] } },
  { ticker: 'RUBICON',    name: 'Rubicon Research Ltd.',              sector: 'Pharma',          bseCode: '544578',
    fda: { sponsors: ['RUBICON'], firms: ['Rubicon Research'] } },
  { ticker: 'IVALUE',     name: 'iValue Infosolutions Ltd.',          sector: 'Technology',      bseCode: '544523' },
  { ticker: 'VENKEYS',    name: "Venky's (India) Ltd.",               sector: 'Food Processing', bseCode: '523261' },
  // Taro is a wholly owned Sun subsidiary.
  { ticker: 'SUNPHARMA',  name: 'Sun Pharmaceutical Industries Ltd.', sector: 'Pharma',          bseCode: '524715',
    fda: { sponsors: ['SUN PHARM', 'TARO'], firms: ['Sun Pharmaceutical', 'Taro Pharmaceuticals'] } },
];

export const watchlistEntry = (ticker: string) => WATCHLIST.find(c => c.ticker === ticker);

// Removed on 2026-11-17. update-watchlist.ts deletes their data.
export const REMOVED_TICKERS = [
  'RPOWER', 'SAMMAANCAP', 'SHAKTIPUMP', 'MMTC',
  'HDFCBANK', 'ICICIBC', 'AXISBANK', 'KOTAKBANK', 'SBIN',
  'INFY', 'TCS', 'WIPRO', 'RELIANCE', 'BAJFINANCE',
  // Removed on 2026-11-18
  'PSPPROJECT',
];

export const STATIC_BSE_CODES: Record<string, string> =
  Object.fromEntries(WATCHLIST.map(c => [c.ticker, c.bseCode]));
