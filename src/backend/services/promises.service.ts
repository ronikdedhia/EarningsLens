import { searchChunks } from './qdrant.service';
import { embedText } from './embedding.service';
import { extractGuidancePromises, resolvePromise } from './groq.service';
import {
  savePromises,
  getPendingPromises,
  updatePromiseStatus,
  getPromises,
  type GuidancePromiseRow,
} from './turso.service';

const MGMT_QUERY = 'management guidance targets commitments promises revenue margin outlook';

async function fetchMgmtChunks(ticker: string, quarter: string, limit = 40): Promise<string> {
  const vector = await embedText(MGMT_QUERY);
  const [ceoChunks, cfoChunks] = await Promise.all([
    searchChunks(vector, { ticker, quarters: [quarter], speakerRole: 'CEO' }, limit),
    searchChunks(vector, { ticker, quarters: [quarter], speakerRole: 'CFO' }, limit),
  ]);
  return [...ceoChunks, ...cfoChunks]
    .map(c => `[${(c.payload as Record<string, string>).speakerRole} ${(c.payload as Record<string, string>).speakerName ?? ''}] ${(c.payload as Record<string, string>).text}`)
    .join('\n\n');
}

export async function extractPromisesForQuarter(
  ticker: string,
  quarter: string,
): Promise<GuidancePromiseRow[]> {
  const transcriptText = await fetchMgmtChunks(ticker, quarter);
  if (!transcriptText.trim()) return [];

  const extracted = await extractGuidancePromises(ticker, quarter, transcriptText);
  if (!extracted.length) return [];

  const rows = extracted.map(p => ({
    ticker,
    quarterPromised: quarter,
    speaker: p.speaker,
    category: p.category,
    verbatimQuote: p.verbatimQuote,
    timeframe: p.timeframe,
    confidenceScore: p.confidenceScore,
    directLanguage: p.directLanguage,
    status: 'pending' as const,
    resolutionNote: '',
    resolvedInQuarter: '',
  }));

  await savePromises(rows);
  return getPromises(ticker, quarter);
}

export async function resolvePromisesForQuarter(
  ticker: string,
  newQuarter: string,
): Promise<{ resolved: number }> {
  const pending = await getPendingPromises(ticker);
  if (!pending.length) return { resolved: 0 };

  const vector = await embedText(MGMT_QUERY);
  const [ceoChunks, cfoChunks] = await Promise.all([
    searchChunks(vector, { ticker, quarters: [newQuarter], speakerRole: 'CEO' }, 40),
    searchChunks(vector, { ticker, quarters: [newQuarter], speakerRole: 'CFO' }, 40),
  ]);
  const newQuarterText = [...ceoChunks, ...cfoChunks]
    .map(c => (c.payload as Record<string, string>).text)
    .join('\n\n');

  if (!newQuarterText.trim()) return { resolved: 0 };

  let resolved = 0;
  for (const promise of pending) {
    try {
      const result = await resolvePromise(
        { verbatimQuote: promise.verbatimQuote, timeframe: promise.timeframe, category: promise.category },
        newQuarterText,
        newQuarter,
      );
      await updatePromiseStatus(promise.id, result.status, result.resolutionNote, newQuarter);
      resolved++;
    } catch {
      // Non-fatal
    }
  }

  return { resolved };
}
