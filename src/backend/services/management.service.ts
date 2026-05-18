import { embedText } from './embedding.service';
import { searchChunks } from './qdrant.service';
import { scoreManagementQuality } from './groq.service';
import { saveManagementScore, getManagementScores, type ManagementScoreRow } from './turso.service';

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
  if (qn === 1) { qn = 4; fy -= 1; }
  else { qn -= 1; }
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
  // fallback: any speaker in this quarter
  const any = await searchChunks(vec, { ticker, quarters: [quarter] }, 6);
  return any.map(c => c.payload?.text as string).filter(Boolean).join('\n\n');
}

export async function analyzeManagementForTicker(
  ticker: string,
  quarters: string[],
): Promise<ManagementScoreRow[]> {
  const sorted = [...quarters].sort((a, b) => quarterToInt(a) - quarterToInt(b));

  // Pre-fetch all quarter texts; prev quarter might not be in the `quarters` list
  const textCache: Record<string, string> = {};
  for (const q of sorted) {
    textCache[q] = await fetchMgmtText(ticker, q);
  }

  const results: ManagementScoreRow[] = [];

  for (const quarter of sorted) {
    const mgmtText = textCache[quarter];
    if (!mgmtText) continue;

    const prevLabel = prevQuarterLabel(quarter);
    let prevText: string | undefined;
    if (prevLabel) {
      prevText = textCache[prevLabel] ?? await fetchMgmtText(ticker, prevLabel);
      if (!textCache[prevLabel]) textCache[prevLabel] = prevText;
    }

    const score = await scoreManagementQuality(
      ticker, quarter, mgmtText,
      prevText || undefined, prevLabel || undefined,
    );

    const composite = Math.round((score.confidence + score.transparency + score.followThrough) / 3);
    const rowData: Omit<ManagementScoreRow, 'id' | 'createdAt'> = {
      ticker,
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

  return results;
}

export { getManagementScores };
