import { scrollChunks } from './qdrant.service';
import { scanRedFlags } from './groq.service';
import { saveRedFlags, getRedFlags, type RedFlagRow } from './turso.service';

export async function scanAndSaveRedFlags(
  ticker: string,
  quarter: string,
): Promise<RedFlagRow[]> {
  const chunks = await scrollChunks({ ticker, quarters: [quarter] }, 400);
  if (!chunks.length) return [];

  const transcriptText = chunks
    .map(c => `[${c.speakerRole}] ${c.text}`)
    .join('\n\n');

  const flags = await scanRedFlags(ticker, quarter, transcriptText);
  if (!flags.length) return [];

  await saveRedFlags(flags.map(f => ({
    ticker,
    quarter,
    flagType: f.flagType,
    severity: f.severity,
    evidence: f.evidence,
  })));

  return getRedFlags(ticker, quarter);
}
