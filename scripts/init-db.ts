/**
 * Idempotent DB setup — safe to re-run at any time.
 * Creates tables if missing, adds new columns to existing tables.
 * Usage: npx tsx scripts/init-db.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function httpUrl(raw: string): string {
  return raw.replace(/^libsql:\/\//, 'https://').replace(/^wss?:\/\//, 'https://');
}

const BASE = httpUrl(process.env.TURSO_DATABASE_URL!);

async function runPipeline(
  statements: string[],
  { ignoreDuplicateColumn = false } = {}
): Promise<void> {
  const res = await fetch(`${BASE}/v2/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TURSO_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        ...statements.map((sql) => ({ type: 'execute', stmt: { sql } })),
        { type: 'close' },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${await res.text()}`);

  const { results } = await res.json();
  results.forEach((r: { type: string; error?: { message: string } }, i: number) => {
    if (r.type !== 'error') return;
    const msg = r.error?.message ?? '';
    if (ignoreDuplicateColumn && msg.includes('duplicate column name')) return;
    throw new Error(`Statement ${i + 1} failed: ${msg}`);
  });
}

// ── Create tables (skipped silently if already exist) ────────────────────────

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS companies (
    ticker     TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sector     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // pdf_url  : BSE/NSE PDF link — set this to queue a transcript for ingestion
  // ingested_at : NULL = pending · timestamp = done (idempotency guard)
  `CREATE TABLE IF NOT EXISTS quarter_index (
    ticker       TEXT NOT NULL,
    quarter      TEXT NOT NULL,
    fiscal_year  INTEGER NOT NULL,
    published_at TEXT NOT NULL,
    pdf_url      TEXT NOT NULL DEFAULT '',
    ingested_at  TEXT,
    PRIMARY KEY (ticker, quarter),
    FOREIGN KEY (ticker) REFERENCES companies(ticker)
  )`,

  `CREATE TABLE IF NOT EXISTS sentiment_scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker          TEXT NOT NULL,
    quarter         TEXT NOT NULL,
    topic           TEXT NOT NULL,
    sentiment_label TEXT NOT NULL CHECK (sentiment_label IN ('positive','negative','neutral')),
    sentiment_score REAL NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Persists every RAG query + LLM answer; vectors live in Qdrant query_log collection
  `CREATE TABLE IF NOT EXISTS query_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    query      TEXT NOT NULL,
    answer     TEXT NOT NULL,
    ticker     TEXT,
    quarters   TEXT,
    rating     INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS management_scores (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker         TEXT NOT NULL,
    quarter        TEXT NOT NULL,
    confidence     REAL NOT NULL,
    transparency   REAL NOT NULL,
    follow_through REAL NOT NULL,
    composite      REAL NOT NULL,
    summary        TEXT NOT NULL DEFAULT '',
    hedge_words    TEXT NOT NULL DEFAULT '[]',
    prev_promises  TEXT NOT NULL DEFAULT '[]',
    delivery_note  TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(ticker, quarter)
  )`,

  `CREATE TABLE IF NOT EXISTS users (
    clerk_user_id TEXT PRIMARY KEY,
    is_premium    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS user_companies (
    clerk_user_id TEXT NOT NULL,
    ticker        TEXT NOT NULL,
    added_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (clerk_user_id, ticker)
  )`,

  `CREATE TABLE IF NOT EXISTS sector_narratives (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sector       TEXT NOT NULL,
    quarter      TEXT NOT NULL,
    themes       TEXT NOT NULL DEFAULT '[]',
    emerging     TEXT NOT NULL DEFAULT '[]',
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sector, quarter)
  )`,

  `CREATE TABLE IF NOT EXISTS red_flags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker      TEXT NOT NULL,
    quarter     TEXT NOT NULL,
    flag_type   TEXT NOT NULL,
    severity    TEXT NOT NULL CHECK (severity IN ('Low','Medium','High')),
    evidence    TEXT NOT NULL DEFAULT '',
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(ticker, quarter, flag_type)
  )`,

  `CREATE TABLE IF NOT EXISTS guidance_promises (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker              TEXT NOT NULL,
    quarter_promised    TEXT NOT NULL,
    speaker             TEXT NOT NULL DEFAULT '',
    category            TEXT NOT NULL DEFAULT 'Other',
    verbatim_quote      TEXT NOT NULL,
    timeframe           TEXT NOT NULL DEFAULT '',
    confidence_score    REAL NOT NULL DEFAULT 3,
    direct_language     INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','delivered','partial','missed')),
    resolution_note     TEXT NOT NULL DEFAULT '',
    resolved_in_quarter TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(ticker, quarter_promised, verbatim_quote)
  )`,

  `CREATE TABLE IF NOT EXISTS daily_filings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker       TEXT NOT NULL,
    filing_date  TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT '',
    title        TEXT NOT NULL,
    pdf_url      TEXT NOT NULL,
    text_content TEXT NOT NULL DEFAULT '',
    importance   INTEGER NOT NULL DEFAULT 1,
    is_important INTEGER NOT NULL DEFAULT 0,
    filing_cat   TEXT NOT NULL DEFAULT 'other',
    insights     TEXT NOT NULL DEFAULT 'null',
    sentiment    TEXT NOT NULL DEFAULT 'neutral',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pdf_url)
  )`,
];

// ── Migrations: add columns to existing tables ───────────────────────────────
// SQLite has no "ADD COLUMN IF NOT EXISTS" — we run each and ignore
// "duplicate column name" errors, which means the column already exists.

const ADD_COLUMNS = [
  `ALTER TABLE quarter_index ADD COLUMN pdf_url     TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE quarter_index ADD COLUMN ingested_at TEXT`,
  `ALTER TABLE companies     ADD COLUMN bse_code    TEXT`,
  `ALTER TABLE query_log     ADD COLUMN rating      INTEGER`,
];

// ── Indexes ───────────────────────────────────────────────────────────────────

const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_qi_ticker   ON quarter_index (ticker)`,
  `CREATE INDEX IF NOT EXISTS idx_qi_pending  ON quarter_index (ingested_at) WHERE ingested_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sent_ticker ON sentiment_scores (ticker, quarter)`,
  `CREATE INDEX IF NOT EXISTS idx_mgmt_ticker ON management_scores (ticker)`,
  `CREATE INDEX IF NOT EXISTS idx_sector_quarter   ON sector_narratives (sector, quarter)`,
  `CREATE INDEX IF NOT EXISTS idx_redflags_ticker  ON red_flags (ticker, quarter)`,
  `CREATE INDEX IF NOT EXISTS idx_redflags_recent  ON red_flags (detected_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_promises_ticker  ON guidance_promises (ticker, quarter_promised)`,
  `CREATE INDEX IF NOT EXISTS idx_promises_pending ON guidance_promises (status) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_daily_filings_ticker_date ON daily_filings (ticker, filing_date)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_filings_date        ON daily_filings (filing_date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_filings_important   ON daily_filings (is_important, filing_date DESC)`,
];

// ── Seed companies ────────────────────────────────────────────────────────────

const SEED_COMPANIES = [
  `INSERT OR IGNORE INTO companies (ticker, name, sector) VALUES
    ('HDFCBANK',   'HDFC Bank Ltd.',           'Banking'),
    ('ICICIBC',    'ICICI Bank Ltd.',           'Banking'),
    ('AXISBANK',   'Axis Bank Ltd.',            'Banking'),
    ('KOTAKBANK',  'Kotak Mahindra Bank Ltd.',  'Banking'),
    ('SBIN',       'State Bank of India',       'Banking'),
    ('INFY',       'Infosys Ltd.',              'Technology'),
    ('TCS',        'Tata Consultancy Services', 'Technology'),
    ('WIPRO',      'Wipro Ltd.',                'Technology'),
    ('RELIANCE',   'Reliance Industries Ltd.',  'Conglomerate'),
    ('BAJFINANCE', 'Bajaj Finance Ltd.',        'NBFC')`,
];

async function main() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set in .env.local');
    process.exit(1);
  }

  console.log('Endpoint:', BASE);

  console.log('\nCreating tables...');
  await runPipeline(CREATE_TABLES);
  console.log('  ✓ companies, quarter_index, sentiment_scores, query_log');

  console.log('\nApplying column migrations...');
  // Run one-per-statement so a "duplicate column" on one doesn't abort others
  for (const sql of ADD_COLUMNS) {
    await runPipeline([sql], { ignoreDuplicateColumn: true });
  }
  console.log('  ✓ pdf_url, ingested_at, bse_code, exchange (skipped if already present)');

  console.log('\nCreating indexes...');
  await runPipeline(CREATE_INDEXES);
  console.log('  ✓ indexes (daily_filings indexes included)');

  console.log('\nSeeding companies...');
  await runPipeline(SEED_COMPANIES);
  console.log('  ✓ 10 NSE companies (skipped if already present)');

  console.log('\nDone. Re-runnable at any time — existing data is never overwritten.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
