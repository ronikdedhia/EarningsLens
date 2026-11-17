import { QdrantClient } from '@qdrant/js-client-rest';

export const COLLECTION = 'earnings_transcripts';

export interface ChunkPayload extends Record<string, unknown> {
  ticker: string;
  quarter: string;       // e.g. "Q2FY24"
  fiscalYear: number;
  speakerRole: 'CEO' | 'CFO' | 'Analyst' | 'Moderator' | 'Other';
  speakerName: string;
  topic: string;
  text: string;
  source: string;
  publishedAt: string;   // ISO — enforces no-look-ahead on retrieval
  // Position in the transcript. Absent on chunks ingested before it was added.
  chunkIndex?: number;
  // 'qa' from the first analyst turn onward. Absent on older chunks.
  section?: 'prepared' | 'qa';
}

export interface SearchFilter {
  ticker?: string;
  quarters?: string[];
  speakerRole?: string;
  beforeDate?: string;   // ISO — for temporal integrity in backtests
}

let _client: QdrantClient | null = null;

function client(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({
      url: process.env.QDRANT_URL!,
      apiKey: process.env.QDRANT_API_KEY,
    });
  }
  return _client;
}

export async function searchChunks(
  vector: number[],
  filter: SearchFilter,
  topK = 8
) {
  const must: object[] = [];

  if (filter.ticker) {
    must.push({ key: 'ticker', match: { value: filter.ticker } });
  }
  if (filter.quarters?.length) {
    must.push({ key: 'quarter', match: { any: filter.quarters } });
  }
  if (filter.speakerRole) {
    must.push({ key: 'speakerRole', match: { value: filter.speakerRole } });
  }
  if (filter.beforeDate) {
    must.push({ key: 'publishedAt', range: { lt: filter.beforeDate } });
  }

  return client().search(COLLECTION, {
    vector,
    limit: topK,
    filter: must.length ? { must } : undefined,
    with_payload: true,
  });
}

// Fetch chunks by payload filter only (no vector — use for batch analysis)
export async function scrollChunks(
  filter: SearchFilter,
  maxResults = 500,
): Promise<ChunkPayload[]> {
  const must: object[] = [];
  if (filter.ticker)         must.push({ key: 'ticker',      match: { value: filter.ticker } });
  if (filter.quarters?.length) must.push({ key: 'quarter',   match: { any: filter.quarters } });
  if (filter.speakerRole)    must.push({ key: 'speakerRole', match: { value: filter.speakerRole } });

  const results: ChunkPayload[] = [];
  let offset: string | number | null | undefined = undefined;

  for (;;) {
    const res = await client().scroll(COLLECTION, {
      filter:       must.length ? { must } : undefined,
      limit:        250,
      with_payload: true,
      with_vector:  false,
      offset,
    });
    for (const pt of res.points) results.push(pt.payload as ChunkPayload);
    const nextOffset = res.next_page_offset;
    if (!nextOffset || results.length >= maxResults) break;
    offset = nextOffset as string | number;
  }

  return results.slice(0, maxResults);
}

export async function upsertChunks(
  points: Array<{ id: string; vector: number[]; payload: ChunkPayload }>
) {
  await client().upsert(COLLECTION, {
    wait: true,
    points,
  });
}

/**
 * Recreates the transcripts and query-log collections at `dim` when their size
 * differs and they hold no points. Never deletes a collection with data in it.
 */
export async function recreateCollectionIfEmpty(dim: number, dryRun: boolean): Promise<string> {
  const { collections } = await client().getCollections();
  const notes: string[] = [];
  for (const name of [COLLECTION, QUERY_COLLECTION]) {
    if (!collections.some(c => c.name === name)) { notes.push(`${name}: absent, created on first use`); continue; }
    const info = await client().getCollection(name);
    const size = (info.config?.params?.vectors as { size?: number } | undefined)?.size;
    const points = info.points_count ?? 0;
    if (size === dim) { notes.push(`${name}: ${size}-dim, matches embedder`); continue; }
    // In a dry run the removals haven't happened yet, so count what would be left.
    if (points > 0 && !dryRun) { notes.push(`${name}: ${size}-dim with ${points} points, embedder is ${dim}-dim — NOT recreated (has data)`); continue; }
    if (dryRun) { notes.push(`${name}: ${size}-dim, embedder is ${dim}-dim — would be recreated if empty after removals`); continue; }
    await client().deleteCollection(name);
    await client().createCollection(name, { vectors: { size: dim, distance: 'Cosine' } });
    notes.push(`${name}: recreated at ${dim}-dim (was ${size}-dim, empty)`);
  }
  return notes.join('\n');
}

/** Counts (dryRun) or deletes every point for these tickers in both collections. */
export async function deleteTickerPoints(tickers: string[], dryRun: boolean): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const { collections } = await client().getCollections();
  for (const name of [COLLECTION, QUERY_COLLECTION]) {
    if (!collections.some(c => c.name === name)) continue;
    const filter = { must: [{ key: 'ticker', match: { any: tickers } }] };
    // Qdrant Cloud refuses filters on unindexed fields; query_log never had one.
    await client().createPayloadIndex(name, { field_name: 'ticker', field_schema: 'keyword', wait: true }).catch(() => {});
    const { count } = await client().count(name, { filter, exact: true });
    out[name] = count;
    if (!dryRun && count > 0) await client().delete(name, { filter, wait: true });
  }
  return out;
}

// ── Query log collection ──────────────────────────────────────────────────────

export const QUERY_COLLECTION = 'query_log';

export async function upsertQueryLog(
  vector: number[],
  payload: { query: string; answer: string; ticker?: string; quarters?: string[]; createdAt: string }
): Promise<void> {
  const { collections } = await client().getCollections();
  if (!collections.some(c => c.name === QUERY_COLLECTION)) {
    await client().createCollection(QUERY_COLLECTION, {
      vectors: { size: vector.length, distance: 'Cosine' },
    });
  }
  await client().upsert(QUERY_COLLECTION, {
    wait: false,
    points: [{ id: crypto.randomUUID(), vector, payload }],
  });
}

// vectorSize must be the real embedding length: 1024 for Voyage, 384 for the
// HuggingFace fallback. A hard-coded 1024 made every HF upsert fail on a new setup.
export async function ensureCollection(vectorSize: number) {
  const { collections } = await client().getCollections();
  const exists = collections.some((c) => c.name === COLLECTION);

  if (!exists) {
    await client().createCollection(COLLECTION, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    });
  } else {
    const info = await client().getCollection(COLLECTION);
    const vectors = info.config?.params?.vectors as { size?: number } | undefined;
    if (vectors?.size && vectors.size !== vectorSize) {
      throw new Error(
        `Qdrant collection ${COLLECTION} expects ${vectors.size}-dim vectors but the embedder returned ${vectorSize}. ` +
        'You switched embedding provider: delete the collection and re-ingest.',
      );
    }
  }

  // Ensure payload indexes exist for filtered search
  const indexFields: Array<{ name: string; type: 'keyword' | 'float' | 'datetime' }> = [
    { name: 'ticker',    type: 'keyword' },
    { name: 'quarter',   type: 'keyword' },
    { name: 'speakerRole', type: 'keyword' },
    { name: 'publishedAt', type: 'keyword' },
  ];
  await Promise.all(
    indexFields.map(f =>
      client().createPayloadIndex(COLLECTION, {
        field_name: f.name,
        field_schema: f.type,
      }).catch(() => {/* index may already exist */}),
    ),
  );
}
