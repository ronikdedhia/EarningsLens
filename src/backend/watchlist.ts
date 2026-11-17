// The tracked companies. scripts/init-db.ts seeds these, and
// scripts/update-watchlist.ts adds/removes the database rows to match.
// NSE symbols checked against NSE's announcements API, BSE codes from Screener (2026-11-17).

export interface WatchlistCompany {
  ticker:  string;   // NSE symbol
  name:    string;
  sector:  string;
  bseCode: string;
}

export const WATCHLIST: WatchlistCompany[] = [
  { ticker: 'WOCKPHARMA', name: 'Wockhardt Ltd.',                     sector: 'Pharma',          bseCode: '532300' },
  { ticker: 'IONEXCHANG', name: 'Ion Exchange (India) Ltd.',          sector: 'Water Treatment', bseCode: '500213' },
  { ticker: 'TRUALT',     name: 'TruAlt Bioenergy Ltd.',              sector: 'Energy',          bseCode: '544545' },
  { ticker: 'PSPPROJECT', name: 'PSP Projects Ltd.',                  sector: 'Construction',    bseCode: '540544' },
  { ticker: 'MOREPENLAB', name: 'Morepen Laboratories Ltd.',          sector: 'Pharma',          bseCode: '500288' },
  { ticker: 'RUBICON',    name: 'Rubicon Research Ltd.',              sector: 'Pharma',          bseCode: '544578' },
  { ticker: 'IVALUE',     name: 'iValue Infosolutions Ltd.',          sector: 'Technology',      bseCode: '544523' },
  { ticker: 'VENKEYS',    name: "Venky's (India) Ltd.",               sector: 'Food Processing', bseCode: '523261' },
  { ticker: 'SUNPHARMA',  name: 'Sun Pharmaceutical Industries Ltd.', sector: 'Pharma',          bseCode: '524715' },
];

// Removed on 2026-11-17. update-watchlist.ts deletes their data.
export const REMOVED_TICKERS = [
  'RPOWER', 'SAMMAANCAP', 'SHAKTIPUMP', 'MMTC',
  'HDFCBANK', 'ICICIBC', 'AXISBANK', 'KOTAKBANK', 'SBIN',
  'INFY', 'TCS', 'WIPRO', 'RELIANCE', 'BAJFINANCE',
];

export const STATIC_BSE_CODES: Record<string, string> =
  Object.fromEntries(WATCHLIST.map(c => [c.ticker, c.bseCode]));
