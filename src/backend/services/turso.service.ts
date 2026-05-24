import { createClient, type Client } from '@libsql/client';

let _db: Client | null = null;

function db(): Client {
  if (!_db) {
    const url = process.env.TURSO_DATABASE_URL!
      .replace(/^libsql:\/\//, 'https://')
      .replace(/^wss?:\/\//, 'https://');
    _db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  return _db;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface Company {
  ticker: string;
  name: string;
  sector: string;
  bseCode: string | null;
}

export interface QuarterRow {
  ticker: string;
  quarter: string;
  fiscalYear: number;
  publishedAt: string;
  pdfUrl: string;
  ingestedAt: string | null;
}

export interface QuarterStatus {
  quarter: string;
  fiscalYear: number;
  pdfUrl: string;
  ingestedAt: string | null;
  status: 'ingested' | 'pending' | 'missing';
}

export interface CompanyStatus extends Company {
  quarters: QuarterStatus[];
}

export interface SentimentRow {
  quarter: string;
  sentiment: string;
  score: number;
}

// ── Companies ────────────────────────────────────────────────────────────────

export async function getCompany(ticker: string): Promise<Company | null> {
  const { rows } = await db().execute({
    sql: 'SELECT ticker, name, sector, bse_code AS bseCode FROM companies WHERE ticker = ?',
    args: [ticker],
  });
  return rows.length ? (rows[0] as unknown as Company) : null;
}

export async function listCompanies(): Promise<Company[]> {
  const { rows } = await db().execute(
    'SELECT ticker, name, sector, bse_code AS bseCode FROM companies ORDER BY ticker'
  );
  return rows as unknown as Company[];
}

export async function getBseCode(ticker: string): Promise<string | null> {
  const { rows } = await db().execute({
    sql: 'SELECT bse_code FROM companies WHERE ticker = ?',
    args: [ticker],
  });
  return (rows[0]?.bse_code as string) ?? null;
}

export async function addCompany(ticker: string, name: string, sector: string, bseCode?: string): Promise<boolean> {
  const result = await db().execute({
    sql: `INSERT INTO companies (ticker, name, sector, bse_code, exchange) VALUES (?, ?, ?, ?, 'NSE')
          ON CONFLICT (ticker) DO NOTHING`,
    args: [ticker, name, sector, bseCode ?? null],
  });
  return (result.rowsAffected ?? 0) > 0;
}

export async function setBseCode(ticker: string, code: string): Promise<void> {
  await db().execute({
    sql: 'UPDATE companies SET bse_code = ? WHERE ticker = ?',
    args: [code, ticker],
  });
}

// Returns all companies joined with their quarter rows for the dashboard
export async function listCompaniesWithStatus(): Promise<CompanyStatus[]> {
  const { rows } = await db().execute(`
    SELECT c.ticker, c.name, c.sector, c.bse_code AS bseCode,
           qi.quarter, qi.fiscal_year AS fiscalYear, qi.pdf_url AS pdfUrl, qi.ingested_at AS ingestedAt
    FROM companies c
    LEFT JOIN quarter_index qi ON c.ticker = qi.ticker
    ORDER BY c.ticker, qi.quarter DESC
  `);

  const map = new Map<string, CompanyStatus>();
  for (const row of rows) {
    const ticker = row.ticker as string;
    if (!map.has(ticker)) {
      map.set(ticker, {
        ticker,
        name:     row.name as string,
        sector:   row.sector as string,
        bseCode:  (row.bseCode as string) ?? null,
        quarters: [],
      });
    }
    if (row.quarter) {
      const pdfUrl    = (row.pdfUrl as string) ?? '';
      const ingestedAt = (row.ingestedAt as string) ?? null;
      map.get(ticker)!.quarters.push({
        quarter:    row.quarter as string,
        fiscalYear: row.fiscalYear as number,
        pdfUrl,
        ingestedAt,
        status: ingestedAt ? 'ingested' : pdfUrl ? 'pending' : 'missing',
      });
    }
  }

  return Array.from(map.values());
}

export async function getSystemStats(): Promise<{
  companies: number; ingested: number; pending: number; sectors: number; aiInsights: number;
}> {
  const [compRes, ingRes, pendRes, sectorRes, insightRes] = await Promise.all([
    db().execute('SELECT COUNT(*) AS n FROM companies'),
    db().execute("SELECT COUNT(*) AS n FROM quarter_index WHERE ingested_at != ''"),
    db().execute("SELECT COUNT(*) AS n FROM quarter_index WHERE pdf_url != '' AND ingested_at = ''"),
    db().execute('SELECT COUNT(DISTINCT sector) AS n FROM companies'),
    db().execute('SELECT COUNT(*) AS n FROM insights'),
  ]);
  return {
    companies:  (compRes.rows[0]?.n    as number) ?? 0,
    ingested:   (ingRes.rows[0]?.n     as number) ?? 0,
    pending:    (pendRes.rows[0]?.n    as number) ?? 0,
    sectors:    (sectorRes.rows[0]?.n  as number) ?? 0,
    aiInsights: (insightRes.rows[0]?.n as number) ?? 0,
  };
}

// ── Quarter index ─────────────────────────────────────────────────────────────

export async function isQuarterIngested(ticker: string, quarter: string): Promise<boolean> {
  const { rows } = await db().execute({
    sql: "SELECT 1 FROM quarter_index WHERE ticker = ? AND quarter = ? AND ingested_at != '' LIMIT 1",
    args: [ticker, quarter],
  });
  return rows.length > 0;
}

export async function getPendingIngestions(): Promise<QuarterRow[]> {
  const { rows } = await db().execute(
    `SELECT ticker, quarter, fiscal_year AS fiscalYear, published_at AS publishedAt,
            pdf_url AS pdfUrl, ingested_at AS ingestedAt
     FROM quarter_index
     WHERE pdf_url != '' AND ingested_at = ''
     ORDER BY ticker, quarter`
  );
  return rows as unknown as QuarterRow[];
}

export async function registerQuarter(row: Omit<QuarterRow, 'ingestedAt'>): Promise<void> {
  await db().execute({
    sql: `INSERT INTO quarter_index (ticker, quarter, fiscal_year, published_at, source, pdf_url, ingested_at)
          VALUES (?, ?, ?, ?, ?, ?, '')
          ON CONFLICT (ticker, quarter) DO UPDATE SET pdf_url = excluded.pdf_url, source = excluded.source`,
    args: [row.ticker, row.quarter, row.fiscalYear, row.publishedAt, row.pdfUrl, row.pdfUrl],
  });
}

export async function markIngested(ticker: string, quarter: string): Promise<void> {
  await db().execute({
    sql: 'UPDATE quarter_index SET ingested_at = ? WHERE ticker = ? AND quarter = ?',
    args: [new Date().toISOString(), ticker, quarter],
  });
}

// ── Sentiment ────────────────────────────────────────────────────────────────

export async function saveSentimentScore(
  ticker: string, quarter: string, topic: string, label: string, score: number
): Promise<void> {
  await db().execute({
    sql: `INSERT INTO sentiment_scores (ticker, quarter, topic, sentiment_label, sentiment_score)
          VALUES (?, ?, ?, ?, ?)`,
    args: [ticker, quarter, topic, label, score],
  });
}

// ── Query log ────────────────────────────────────────────────────────────────

export async function saveQueryLog(params: {
  query: string;
  answer: string;
  ticker?: string;
  quarters?: string[];
}): Promise<number> {
  const result = await db().execute({
    sql: `INSERT INTO query_log (query, answer, ticker, quarters) VALUES (?, ?, ?, ?)`,
    args: [
      params.query,
      params.answer,
      params.ticker ?? null,
      params.quarters?.length ? JSON.stringify(params.quarters) : null,
    ],
  });
  return Number(result.lastInsertRowid);
}

export async function rateQuery(id: number, rating: 1 | -1): Promise<void> {
  await db().execute({
    sql: 'UPDATE query_log SET rating = ? WHERE id = ?',
    args: [rating, id],
  });
}

export async function getSentimentHistory(ticker: string, topic?: string): Promise<SentimentRow[]> {
  const { rows } = topic
    ? await db().execute({
        sql: `SELECT quarter, sentiment_label AS sentiment, AVG(sentiment_score) AS score
              FROM sentiment_scores WHERE ticker = ? AND topic = ?
              GROUP BY quarter ORDER BY quarter`,
        args: [ticker, topic],
      })
    : await db().execute({
        sql: `SELECT quarter, sentiment_label AS sentiment, AVG(sentiment_score) AS score
              FROM sentiment_scores WHERE ticker = ?
              GROUP BY quarter ORDER BY quarter`,
        args: [ticker],
      });
  return rows as unknown as SentimentRow[];
}

// ── Insights ─────────────────────────────────────────────────────────────────

export interface InsightRow {
  id: number;
  ticker: string;
  title: string;
  content: string;
  generatedAt: string;
}

export async function getInsights(ticker: string): Promise<InsightRow[]> {
  const { rows } = await db().execute({
    sql: 'SELECT id, ticker, title, content, generated_at AS generatedAt FROM insights WHERE ticker = ? ORDER BY id',
    args: [ticker],
  });
  return rows as unknown as InsightRow[];
}

export async function saveInsight(ticker: string, title: string, content: string): Promise<void> {
  await db().execute({
    sql: 'INSERT INTO insights (ticker, title, content) VALUES (?, ?, ?)',
    args: [ticker, title, content],
  });
}

export async function deleteInsights(ticker: string): Promise<void> {
  await db().execute({
    sql: 'DELETE FROM insights WHERE ticker = ?',
    args: [ticker],
  });
}

export async function getQueryLogsForTicker(ticker: string): Promise<Array<{
  id: number; query: string; answer: string; createdAt: string;
}>> {
  const { rows } = await db().execute({
    sql: 'SELECT id, query, answer, created_at AS createdAt FROM query_log WHERE ticker = ? ORDER BY id DESC LIMIT 10',
    args: [ticker],
  });
  return rows as unknown as Array<{ id: number; query: string; answer: string; createdAt: string }>;
}

// ── User / Paywall ────────────────────────────────────────────────────────────

export async function getUserCompanyCount(clerkUserId: string): Promise<number> {
  const { rows } = await db().execute({
    sql: 'SELECT COUNT(*) AS n FROM user_companies WHERE clerk_user_id = ?',
    args: [clerkUserId],
  });
  return (rows[0]?.n as number) ?? 0;
}

export async function isUserPremium(clerkUserId: string): Promise<boolean> {
  const { rows } = await db().execute({
    sql: 'SELECT is_premium FROM users WHERE clerk_user_id = ?',
    args: [clerkUserId],
  });
  return (rows[0]?.is_premium as number) === 1;
}

export async function upsertUser(clerkUserId: string): Promise<void> {
  await db().execute({
    sql: `INSERT INTO users (clerk_user_id) VALUES (?) ON CONFLICT (clerk_user_id) DO NOTHING`,
    args: [clerkUserId],
  });
}

export async function trackUserCompany(clerkUserId: string, ticker: string): Promise<void> {
  await upsertUser(clerkUserId);
  await db().execute({
    sql: `INSERT INTO user_companies (clerk_user_id, ticker) VALUES (?, ?) ON CONFLICT DO NOTHING`,
    args: [clerkUserId, ticker],
  });
}

// ── Management Quality ────────────────────────────────────────────────────────

export interface ManagementScoreRow {
  id: number;
  ticker: string;
  quarter: string;
  confidence: number;
  transparency: number;
  followThrough: number;
  composite: number;
  summary: string;
  hedgeWords: string[];
  prevPromises: string[];
  deliveryNote: string;
  createdAt: string;
}

export async function getIngestedQuarters(ticker: string): Promise<string[]> {
  const { rows } = await db().execute({
    sql: `SELECT quarter FROM quarter_index WHERE ticker = ? AND ingested_at IS NOT NULL AND ingested_at != '' ORDER BY quarter`,
    args: [ticker],
  });
  return rows.map(r => r.quarter as string);
}

export async function saveManagementScore(
  row: Omit<ManagementScoreRow, 'id' | 'createdAt'>
): Promise<void> {
  await db().execute({
    sql: `INSERT INTO management_scores
          (ticker, quarter, confidence, transparency, follow_through, composite, summary, hedge_words, prev_promises, delivery_note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (ticker, quarter) DO UPDATE SET
            confidence     = excluded.confidence,
            transparency   = excluded.transparency,
            follow_through = excluded.follow_through,
            composite      = excluded.composite,
            summary        = excluded.summary,
            hedge_words    = excluded.hedge_words,
            prev_promises  = excluded.prev_promises,
            delivery_note  = excluded.delivery_note`,
    args: [
      row.ticker, row.quarter, row.confidence, row.transparency,
      row.followThrough, row.composite, row.summary,
      JSON.stringify(row.hedgeWords),
      JSON.stringify(row.prevPromises),
      row.deliveryNote,
    ],
  });
}

// ── Sector Narratives ─────────────────────────────────────────────────────────

export interface SectorTheme {
  theme: string;
  summary: string;
  companies: string[];
  optimistic: string[];
  cautious: string[];
}

export interface SectorEmergingTopic {
  topic: string;
  companies: string[];
  context: string;
}

export interface SectorNarrativeRow {
  id: number;
  sector: string;
  quarter: string;
  themes: SectorTheme[];
  emerging: SectorEmergingTopic[];
  generatedAt: string;
}

export async function saveSectorNarrative(
  sector: string,
  quarter: string,
  themes: SectorTheme[],
  emerging: SectorEmergingTopic[],
): Promise<void> {
  await db().execute({
    sql: `INSERT INTO sector_narratives (sector, quarter, themes, emerging)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (sector, quarter) DO UPDATE SET
            themes       = excluded.themes,
            emerging     = excluded.emerging,
            generated_at = datetime('now')`,
    args: [sector, quarter, JSON.stringify(themes), JSON.stringify(emerging)],
  });
}

export async function getSectorNarrative(
  sector: string,
  quarter: string,
): Promise<SectorNarrativeRow | null> {
  const { rows } = await db().execute({
    sql: `SELECT id, sector, quarter, themes, emerging, generated_at AS generatedAt
          FROM sector_narratives WHERE sector = ? AND quarter = ?`,
    args: [sector, quarter],
  });
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id:          r.id as number,
    sector:      r.sector as string,
    quarter:     r.quarter as string,
    themes:      JSON.parse((r.themes   as string) || '[]'),
    emerging:    JSON.parse((r.emerging as string) || '[]'),
    generatedAt: r.generatedAt as string,
  };
}

export async function listSectorNarratives(sector: string, limit = 4): Promise<SectorNarrativeRow[]> {
  const { rows } = await db().execute({
    sql: `SELECT id, sector, quarter, themes, emerging, generated_at AS generatedAt
          FROM sector_narratives WHERE sector = ?
          ORDER BY quarter DESC LIMIT ?`,
    args: [sector, limit],
  });
  return rows.map(r => ({
    id:          r.id as number,
    sector:      r.sector as string,
    quarter:     r.quarter as string,
    themes:      JSON.parse((r.themes   as string) || '[]'),
    emerging:    JSON.parse((r.emerging as string) || '[]'),
    generatedAt: r.generatedAt as string,
  }));
}

// ── Red Flag Scanner ──────────────────────────────────────────────────────────

export interface RedFlagRow {
  id: number;
  ticker: string;
  quarter: string;
  flagType: string;
  severity: 'Low' | 'Medium' | 'High';
  evidence: string;
  detectedAt: string;
}

export async function saveRedFlags(rows: Omit<RedFlagRow, 'id' | 'detectedAt'>[]): Promise<void> {
  for (const row of rows) {
    await db().execute({
      sql: `INSERT INTO red_flags (ticker, quarter, flag_type, severity, evidence)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (ticker, quarter, flag_type) DO UPDATE SET
              severity = excluded.severity,
              evidence = excluded.evidence`,
      args: [row.ticker, row.quarter, row.flagType, row.severity, row.evidence],
    });
  }
}

export async function getRedFlags(ticker: string, quarter?: string): Promise<RedFlagRow[]> {
  const { rows } = quarter
    ? await db().execute({
        sql: `SELECT id, ticker, quarter, flag_type AS flagType, severity, evidence, detected_at AS detectedAt
              FROM red_flags WHERE ticker = ? AND quarter = ? ORDER BY severity DESC, id`,
        args: [ticker, quarter],
      })
    : await db().execute({
        sql: `SELECT id, ticker, quarter, flag_type AS flagType, severity, evidence, detected_at AS detectedAt
              FROM red_flags WHERE ticker = ? ORDER BY quarter DESC, severity DESC`,
        args: [ticker],
      });
  return rows as unknown as RedFlagRow[];
}

export async function getRecentRedFlags(days = 7, limit = 50): Promise<RedFlagRow[]> {
  const { rows } = await db().execute({
    sql: `SELECT id, ticker, quarter, flag_type AS flagType, severity, evidence, detected_at AS detectedAt
          FROM red_flags
          WHERE detected_at >= datetime('now', ?)
          ORDER BY detected_at DESC LIMIT ?`,
    args: [`-${days} days`, limit],
  });
  return rows as unknown as RedFlagRow[];
}

// ── Guidance Promise Tracker ──────────────────────────────────────────────────

export interface GuidancePromiseRow {
  id: number;
  ticker: string;
  quarterPromised: string;
  speaker: string;
  category: string;
  verbatimQuote: string;
  timeframe: string;
  confidenceScore: number;
  directLanguage: boolean;
  status: 'pending' | 'delivered' | 'partial' | 'missed';
  resolutionNote: string;
  resolvedInQuarter: string;
  createdAt: string;
}

export async function savePromises(rows: Omit<GuidancePromiseRow, 'id' | 'createdAt'>[]): Promise<void> {
  for (const row of rows) {
    await db().execute({
      sql: `INSERT INTO guidance_promises
            (ticker, quarter_promised, speaker, category, verbatim_quote, timeframe,
             confidence_score, direct_language, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
            ON CONFLICT (ticker, quarter_promised, verbatim_quote) DO NOTHING`,
      args: [
        row.ticker, row.quarterPromised, row.speaker, row.category,
        row.verbatimQuote, row.timeframe, row.confidenceScore,
        row.directLanguage ? 1 : 0,
      ],
    });
  }
}

export async function getPromises(ticker: string, quarter?: string): Promise<GuidancePromiseRow[]> {
  const { rows } = quarter
    ? await db().execute({
        sql: `SELECT id, ticker, quarter_promised AS quarterPromised, speaker, category,
                     verbatim_quote AS verbatimQuote, timeframe, confidence_score AS confidenceScore,
                     direct_language AS directLanguage, status, resolution_note AS resolutionNote,
                     resolved_in_quarter AS resolvedInQuarter, created_at AS createdAt
              FROM guidance_promises WHERE ticker = ? AND quarter_promised = ? ORDER BY id`,
        args: [ticker, quarter],
      })
    : await db().execute({
        sql: `SELECT id, ticker, quarter_promised AS quarterPromised, speaker, category,
                     verbatim_quote AS verbatimQuote, timeframe, confidence_score AS confidenceScore,
                     direct_language AS directLanguage, status, resolution_note AS resolutionNote,
                     resolved_in_quarter AS resolvedInQuarter, created_at AS createdAt
              FROM guidance_promises WHERE ticker = ? ORDER BY quarter_promised DESC, id`,
        args: [ticker],
      });
  return rows.map(r => ({ ...r, directLanguage: r.directLanguage === 1 })) as unknown as GuidancePromiseRow[];
}

export async function getPendingPromises(ticker: string): Promise<GuidancePromiseRow[]> {
  const { rows } = await db().execute({
    sql: `SELECT id, ticker, quarter_promised AS quarterPromised, speaker, category,
                 verbatim_quote AS verbatimQuote, timeframe, confidence_score AS confidenceScore,
                 direct_language AS directLanguage, status, resolution_note AS resolutionNote,
                 resolved_in_quarter AS resolvedInQuarter, created_at AS createdAt
          FROM guidance_promises WHERE ticker = ? AND status = 'pending' ORDER BY quarter_promised, id`,
    args: [ticker],
  });
  return rows.map(r => ({ ...r, directLanguage: r.directLanguage === 1 })) as unknown as GuidancePromiseRow[];
}

export async function updatePromiseStatus(
  id: number,
  status: 'delivered' | 'partial' | 'missed',
  resolutionNote: string,
  resolvedInQuarter: string,
): Promise<void> {
  await db().execute({
    sql: `UPDATE guidance_promises
          SET status = ?, resolution_note = ?, resolved_in_quarter = ?
          WHERE id = ?`,
    args: [status, resolutionNote, resolvedInQuarter, id],
  });
}

export async function getManagementScores(ticker: string): Promise<ManagementScoreRow[]> {
  const { rows } = await db().execute({
    sql: `SELECT id, ticker, quarter, confidence, transparency,
                 follow_through AS followThrough, composite, summary,
                 hedge_words AS hedgeWords, prev_promises AS prevPromises,
                 delivery_note AS deliveryNote, created_at AS createdAt
          FROM management_scores WHERE ticker = ? ORDER BY quarter`,
    args: [ticker],
  });
  return rows.map(r => ({
    ...r,
    followThrough: r.followThrough as number,
    hedgeWords:   JSON.parse((r.hedgeWords  as string) || '[]'),
    prevPromises: JSON.parse((r.prevPromises as string) || '[]'),
  })) as unknown as ManagementScoreRow[];
}
