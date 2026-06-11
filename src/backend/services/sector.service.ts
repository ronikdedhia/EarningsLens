import { sectorGraph } from '../graphs/sector.graph';
import {
  getSectorNarrative,
  listSectorNarratives,
  listCompanies,
  type SectorNarrativeRow,
} from './turso.service';

export async function generateSectorNarrative(
  sector: string,
  quarter: string,
  forceRefresh = false,
): Promise<SectorNarrativeRow> {
  if (!forceRefresh) {
    const cached = await getSectorNarrative(sector, quarter);
    if (cached) return cached;
  }

  const state = await sectorGraph.invoke({
    sector,
    quarter,
    forceRefresh,
    companyTexts: {},
    prevThemes:   [],
    analysis:     { themes: [], emerging: [] },
    result:       null as unknown as SectorNarrativeRow,
  });
  return state.result;
}

export async function getSectorEvolution(sector: string): Promise<SectorNarrativeRow[]> {
  return listSectorNarratives(sector, 4);
}

export async function listAvailableSectors(): Promise<string[]> {
  const companies = await listCompanies();
  return [...new Set(companies.map(c => c.sector))].sort();
}
