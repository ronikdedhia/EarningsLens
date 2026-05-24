import { QdrantClient } from '@qdrant/js-client-rest';

export const COLLECTION = 'earnings_transcripts';

export interface ChunkPayload extends Record<string, unknown> {
  ticker: string;
  quarter: string;       // e.g. "Q2FY24"
  fiscalYear: number;
  speakerRole: 'CEO' | 'CFO' | 'Analyst' | 'Other';
  speakerName: string;
  topic: string;
  text: string;
  source: string;
  publishedAt: string;   // ISO — enforces no-look-ahead on retrieval
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

export async function ensureCollection(vectorSize = 1024) {
  const { collections } = await client().getCollections();
  const exists = collections.some((c) => c.name === COLLECTION);

  if (!exists) {
    await client().createCollection(COLLECTION, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    });
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
