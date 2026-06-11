import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { scrollChunks } from '../services/qdrant.service';
import { extractSectorThemes, type SectorAnalysisResult } from '../services/groq.service';
import {
  listCompanies,
  saveSectorNarrative,
  getSectorNarrative,
  type SectorNarrativeRow,
} from '../services/turso.service';

function prevQuarters(quarter: string, n: number): string[] {
  const m = quarter.match(/Q(\d)FY(\d{2,4})/);
  if (!m) return [];
  let q  = parseInt(m[1]);
  let fy = parseInt(m[2].length === 2 ? m[2] : m[2].slice(-2));
  const result: string[] = [];
  for (let i = 0; i < n; i++) {
    q--;
    if (q < 1) { q = 4; fy--; }
    result.push(`Q${q}FY${String(fy).padStart(2, '0')}`);
  }
  return result;
}

// ── State ─────────────────────────────────────────────────────────────────────

const SectorAnnotation = Annotation.Root({
  sector:        Annotation<string>,
  quarter:       Annotation<string>,
  forceRefresh:  Annotation<boolean>,
  companyTexts:  Annotation<Record<string, string>>,
  prevThemes:    Annotation<string[]>,
  analysis:      Annotation<SectorAnalysisResult>,
  result:        Annotation<SectorNarrativeRow>,
});

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function fetchChunksNode(state: typeof SectorAnnotation.State) {
  const allCompanies = await listCompanies();
  const sectorCompanies = allCompanies.filter(
    c => c.sector.toLowerCase() === state.sector.toLowerCase()
  );
  if (!sectorCompanies.length) throw new Error(`No companies found for sector: ${state.sector}`);

  const companyTexts: Record<string, string> = {};
  await Promise.all(
    sectorCompanies.map(async company => {
      const [ceo, cfo] = await Promise.all([
        scrollChunks({ ticker: company.ticker, quarters: [state.quarter], speakerRole: 'CEO' }, 20),
        scrollChunks({ ticker: company.ticker, quarters: [state.quarter], speakerRole: 'CFO' }, 20),
      ]);
      const text = [...ceo, ...cfo].map(c => c.text).join('\n\n');
      if (text.trim()) companyTexts[company.ticker] = text;
    })
  );

  if (!Object.keys(companyTexts).length) {
    throw new Error(`No ingested data found for sector ${state.sector} in ${state.quarter}`);
  }

  const twoBack = prevQuarters(state.quarter, 2);
  const oldNarrative = twoBack.length
    ? await getSectorNarrative(state.sector, twoBack[twoBack.length - 1])
    : null;
  const prevThemes = oldNarrative?.themes.map((t: { theme: string }) => t.theme) ?? [];

  return { companyTexts, prevThemes };
}

async function analyzeNode(state: typeof SectorAnnotation.State) {
  const analysis = await extractSectorThemes(
    state.sector, state.quarter, state.companyTexts, state.prevThemes
  );
  return { analysis };
}

async function saveNode(state: typeof SectorAnnotation.State) {
  await saveSectorNarrative(state.sector, state.quarter, state.analysis.themes, state.analysis.emerging);
  const result = await getSectorNarrative(state.sector, state.quarter);
  return { result: result! };
}

// ── Graph ─────────────────────────────────────────────────────────────────────

const workflow = new StateGraph(SectorAnnotation)
  .addNode('fetch',   fetchChunksNode)
  .addNode('analyze', analyzeNode)
  .addNode('save',    saveNode)
  .addEdge(START,     'fetch')
  .addEdge('fetch',   'analyze')
  .addEdge('analyze', 'save')
  .addEdge('save',    END);

export const sectorGraph = workflow.compile();
