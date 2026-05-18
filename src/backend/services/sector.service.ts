import { scrollChunks } from './qdrant.service';
import { extractSectorThemes } from './groq.service';
import {
  listCompanies,
  saveSectorNarrative,
  getSectorNarrative,
  listSectorNarratives,
  type SectorNarrativeRow,
} from './turso.service';

function quarterToInt(q: string): number {
  const m = q.match(/Q(\d)FY(\d{2,4})/);
  if (!m) return 0;
  const fy = m[2].length === 2 ? parseInt(m[2]) : parseInt(m[2]) % 100;
  return fy * 10 + parseInt(m[1]);
}

function prevQuarters(quarter: string, n: number): string[] {
  const m = quarter.match(/Q(\d)FY(\d{2,4})/);
  if (!m) return [];
  let q = parseInt(m[1]);
  let fy = parseInt(m[2].length === 2 ? m[2] : m[2].slice(-2));
  const result: string[] = [];
  for (let i = 0; i < n; i++) {
    q--;
    if (q < 1) { q = 4; fy--; }
    result.push(`Q${q}FY${String(fy).padStart(2, '0')}`);
  }
  return result;
}

export async function generateSectorNarrative(
  sector: string,
  quarter: string,
  forceRefresh = false,
): Promise<SectorNarrativeRow> {
  // Return cached unless force refresh
  if (!forceRefresh) {
    const cached = await getSectorNarrative(sector, quarter);
    if (cached) return cached;
  }

  // Get companies in this sector
  const allCompanies = await listCompanies();
  const sectorCompanies = allCompanies.filter(
    c => c.sector.toLowerCase() === sector.toLowerCase()
  );
  if (!sectorCompanies.length) {
    throw new Error(`No companies found for sector: ${sector}`);
  }

  const tickers = sectorCompanies.map(c => c.ticker);

  // Fetch management chunks for each company this quarter (CEO + CFO only)
  const companyTexts: Record<string, string> = {};
  await Promise.all(
    tickers.map(async ticker => {
      const [ceo, cfo] = await Promise.all([
        scrollChunks({ ticker, quarters: [quarter], speakerRole: 'CEO' }, 20),
        scrollChunks({ ticker, quarters: [quarter], speakerRole: 'CFO' }, 20),
      ]);
      const text = [...ceo, ...cfo].map(c => c.text).join('\n\n');
      if (text.trim()) companyTexts[ticker] = text;
    })
  );

  if (!Object.keys(companyTexts).length) {
    throw new Error(`No ingested data found for sector ${sector} in ${quarter}`);
  }

  // Get themes from 2 quarters ago for emerging topic comparison
  const twoBack = prevQuarters(quarter, 2);
  const oldNarrative = twoBack.length
    ? await getSectorNarrative(sector, twoBack[twoBack.length - 1])
    : null;
  const prevThemeNames = oldNarrative?.themes.map(t => t.theme) ?? [];

  // Run LLM analysis
  const result = await extractSectorThemes(sector, quarter, companyTexts, prevThemeNames);

  // Save and return
  await saveSectorNarrative(sector, quarter, result.themes, result.emerging);
  return (await getSectorNarrative(sector, quarter))!;
}

export async function getSectorEvolution(sector: string): Promise<SectorNarrativeRow[]> {
  return listSectorNarratives(sector, 4);
}

export async function listAvailableSectors(): Promise<string[]> {
  const companies = await listCompanies();
  const sectors = [...new Set(companies.map(c => c.sector))].sort();
  return sectors;
}
