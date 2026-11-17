import type { ChunkPayload } from '../services/qdrant.service';

// ── Quarter ordering ──────────────────────────────────────────────────────────

/** "Q3FY26" → sortable integer; 0 for anything that isn't a quarter label. */
export function quarterToInt(q: string): number {
  const m = q.match(/^Q([1-4])FY(\d{2}|\d{4})$/);
  if (!m) return 0;
  const fy = m[2].length === 2 ? 2000 + parseInt(m[2], 10) : parseInt(m[2], 10);
  return fy * 4 + parseInt(m[1], 10);
}

// ── Chunk ordering ────────────────────────────────────────────────────────────

/**
 * Qdrant scroll returns points in id order, and ids are random UUIDs, so a
 * scrolled transcript comes back shuffled. Chunks ingested after this change
 * carry `chunkIndex`; older chunks without it keep their relative order at the end.
 */
export function orderChunks<T extends Pick<ChunkPayload, 'chunkIndex'>>(chunks: T[]): T[] {
  return chunks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ai = typeof a.c.chunkIndex === 'number' ? a.c.chunkIndex : Number.MAX_SAFE_INTEGER;
      const bi = typeof b.c.chunkIndex === 'number' ? b.c.chunkIndex : Number.MAX_SAFE_INTEGER;
      return ai - bi || a.i - b.i;
    })
    .map(x => x.c);
}

// ── Windowing ─────────────────────────────────────────────────────────────────

export function analysisWindowChars(): number {
  const n = parseInt(process.env.ANALYSIS_WINDOW_CHARS ?? '', 10);
  // ~2.5K tokens: one window plus prompt and answer stays well under an 8K TPM limit.
  return Number.isFinite(n) && n >= 2000 ? n : 10000;
}

/**
 * Packs blocks into windows of at most `maxChars`, never splitting a block unless
 * a single block is larger than the window. Every character of input appears in
 * exactly one window, so a map step over the windows sees the whole transcript.
 */
export function packWindows(blocks: string[], maxChars = analysisWindowChars(), sep = '\n\n'): string[] {
  const windows: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (!block) continue;
    const pieces: string[] = [];
    for (let i = 0; i < block.length; i += maxChars) pieces.push(block.slice(i, i + maxChars));
    for (const piece of pieces) {
      if (!current) { current = piece; continue; }
      if (current.length + sep.length + piece.length <= maxChars) {
        current += sep + piece;
      } else {
        windows.push(current);
        current = piece;
      }
    }
  }
  if (current) windows.push(current);
  return windows;
}

/** Renders ordered chunks as speaker-labelled blocks for LLM input. */
export function chunkBlocks(chunks: ChunkPayload[]): string[] {
  return orderChunks(chunks).map(c => {
    const section = c.section === 'qa' ? 'Q&A' : c.section === 'prepared' ? 'Prepared remarks' : '';
    const label = [c.speakerRole, c.speakerName].filter(Boolean).join(' ');
    return `[${section ? `${section} · ` : ''}${label}] ${c.text}`;
  });
}

// ── Merging map-step results ──────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = { Low: 1, Medium: 2, High: 3 };

/** One row per flag type: keep the most severe occurrence and its evidence. */
export function mergeRedFlags<T extends { flagType: string; severity: string; evidence: string }>(flags: T[]): T[] {
  const best = new Map<string, T>();
  for (const f of flags) {
    const prev = best.get(f.flagType);
    if (!prev || (SEVERITY_RANK[f.severity] ?? 0) > (SEVERITY_RANK[prev.severity] ?? 0)) {
      best.set(f.flagType, f);
    }
  }
  return [...best.values()];
}

function normalizeQuote(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
}

/** Drops promises whose quote repeats (or is contained in) an earlier one. */
export function dedupePromises<T extends { verbatimQuote: string; confidenceScore: number }>(promises: T[], max = 15): T[] {
  const kept: Array<{ p: T; key: string }> = [];
  for (const p of promises) {
    const key = normalizeQuote(p.verbatimQuote);
    if (!key) continue;
    const dup = kept.findIndex(k => k.key === key || k.key.includes(key) || key.includes(k.key));
    if (dup === -1) kept.push({ p, key });
    else if (p.confidenceScore > kept[dup].p.confidenceScore) kept[dup] = { p, key };
  }
  return kept
    .map(k => k.p)
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, max);
}
