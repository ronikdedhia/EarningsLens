import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { embedText } from '../services/embedding.service';
import { searchChunks } from '../services/qdrant.service';
import { scoreManagementQuality } from '../services/groq.service';
import { saveManagementScore, getManagementScores, type ManagementScoreRow } from '../services/turso.service';

function quarterToInt(q: string): number {
  const m = q.match(/^Q(\d)FY(\d{2,4})$/);
  if (!m) return 0;
  const fyEnd = parseInt(m[2]) < 100 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
  return fyEnd * 4 + parseInt(m[1]);
}

function prevQuarterLabel(q: string): string | null {
  const m = q.match(/^Q(\d)FY(\d{2,4})$/);
  if (!m) return null;
  let qn = parseInt(m[1]);
  let fy = parseInt(m[2]) < 100 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
  if (qn === 1) { qn = 4; fy -= 1; } else { qn -= 1; }
  return `Q${qn}FY${String(fy).slice(-2)}`;
}

async function fetchMgmtText(ticker: string, quarter: string): Promise<string> {
  const vec = await embedText('management guidance targets commitments strategy results delivery achieved');
  const [ceo, cfo] = await Promise.all([
    searchChunks(vec, { ticker, quarters: [quarter], speakerRole: 'CEO' }, 5),
    searchChunks(vec, { ticker, quarters: [quarter], speakerRole: 'CFO' }, 4),
  ]);
  const combined = [...ceo, ...cfo].map(c => c.payload?.text as string).filter(Boolean);
  if (combined.length) return combined.join('\n\n');
  const any = await searchChunks(vec, { ticker, quarters: [quarter] }, 6);
  return any.map(c => c.payload?.text as string).filter(Boolean).join('\n\n');
}

// ── State ─────────────────────────────────────────────────────────────────────

const ManagementAnnotation = Annotation.Root({
  ticker:   Annotation<string>,
  quarters: Annotation<string[]>,
  result:   Annotation<ManagementScoreRow[]>,
});

// ── Node ──────────────────────────────────────────────────────────────────────

async function analyzeNode(state: typeof ManagementAnnotation.State) {
  const sorted = [...state.quarters].sort((a, b) => quarterToInt(a) - quarterToInt(b));
  const textCache: Record<string, string> = {};

  for (const q of sorted) {
    textCache[q] = await fetchMgmtText(state.ticker, q);
  }

  const results: ManagementScoreRow[] = [];

  for (const quarter of sorted) {
    const mgmtText = textCache[quarter];
    if (!mgmtText) continue;

    const prevLabel = prevQuarterLabel(quarter);
    let prevText: string | undefined;
    if (prevLabel) {
      prevText = textCache[prevLabel] ?? await fetchMgmtText(state.ticker, prevLabel);
      if (!textCache[prevLabel]) textCache[prevLabel] = prevText;
    }

    const score = await scoreManagementQuality(
      state.ticker, quarter, mgmtText,
      prevText || undefined, prevLabel || undefined,
    );

    const composite = Math.round((score.confidence + score.transparency + score.followThrough) / 3);
    const rowData: Omit<ManagementScoreRow, 'id' | 'createdAt'> = {
      ticker:        state.ticker,
      quarter,
      confidence:    score.confidence,
      transparency:  score.transparency,
      followThrough: score.followThrough,
      composite,
      summary:       score.summary,
      hedgeWords:    score.hedgeWords,
      prevPromises:  score.prevPromises,
      deliveryNote:  score.deliveryNote,
    };

    await saveManagementScore(rowData);
    results.push({ ...rowData, id: 0, createdAt: new Date().toISOString() });
  }

  return { result: results };
}

// ── Graph ─────────────────────────────────────────────────────────────────────

const workflow = new StateGraph(ManagementAnnotation)
  .addNode('analyze', analyzeNode)
  .addEdge(START,     'analyze')
  .addEdge('analyze', END);

export const managementGraph = workflow.compile();
