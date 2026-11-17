/**
 * Idempotent DB setup — safe to re-run at any time.
 * Creates tables if missing, adds new columns to existing tables.
 * Usage: npx tsx scripts/init-db.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import { WATCHLIST } from '../src/backend/watchlist';

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

  // Daily closes from NSE. prev_close is NSE's adjusted previous close, so
  // compounding close/prev_close stays correct across splits and bonuses.
  // ticker 'NIFTY 50' holds the index.
  `CREATE TABLE IF NOT EXISTS price_history (
    ticker     TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    close      REAL NOT NULL,
    prev_close REAL NOT NULL,
    PRIMARY KEY (ticker, trade_date)
  )`,

  // Stock and NIFTY 50 move 1, 5 and 20 sessions after each filing, red flag or signal
  `CREATE TABLE IF NOT EXISTS price_reactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL CHECK (event_type IN ('filing','red_flag','signal')),
    event_id    INTEGER NOT NULL,
    ticker      TEXT NOT NULL,
    event_date  TEXT NOT NULL,
    label       TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT '',
    base_date   TEXT,
    ret_1d      REAL, ret_5d REAL, ret_20d REAL,
    nifty_1d    REAL, nifty_5d REAL, nifty_20d REAL,
    complete    INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_type, event_id)
  )`,

  // Quarterly figures from results XBRL, full rupees
  `CREATE TABLE IF NOT EXISTS quarterly_financials (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker        TEXT NOT NULL,
    quarter       TEXT NOT NULL,
    period_end    TEXT NOT NULL,
    basis         TEXT NOT NULL CHECK (basis IN ('Consolidated','Standalone')),
    revenue       REAL, other_income REAL, finance_costs REAL, depreciation REAL,
    exceptional   REAL, pbt REAL, pat REAL, eps REAL, ebitda REAL,
    filed_at      TEXT NOT NULL DEFAULT '',
    seq_id        INTEGER NOT NULL,
    source_url    TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(ticker, period_end, basis)
  )`,

  `CREATE TABLE IF NOT EXISTS board_meetings (
    ticker        TEXT NOT NULL,
    meeting_date  TEXT NOT NULL,
    purpose       TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    is_results    INTEGER NOT NULL DEFAULT 0,
    brief_sent_at TEXT,
    PRIMARY KEY (ticker, meeting_date)
  )`,

  // Insider trades (PIT), SAST Reg 29, pledge snapshots, bulk and block deals
  `CREATE TABLE IF NOT EXISTS market_signals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker        TEXT NOT NULL,
    signal_type   TEXT NOT NULL CHECK (signal_type IN ('insider','sast','pledge','bulk_deal','block_deal')),
    event_date    TEXT NOT NULL,
    event_minutes INTEGER,
    party         TEXT NOT NULL DEFAULT '',
    category      TEXT NOT NULL DEFAULT '',
    direction     TEXT NOT NULL DEFAULT '',
    quantity      REAL, value REAL, price REAL,
    detail        TEXT NOT NULL DEFAULT '',
    dedup_key     TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  `ALTER TABLE daily_filings ADD COLUMN filed_at    TEXT`,
  `ALTER TABLE quarter_index ADD COLUMN transcript_filed_at TEXT`,
  // Older databases created quarter_index with `source TEXT NOT NULL`; registerQuarter writes it.
  `ALTER TABLE quarter_index ADD COLUMN source TEXT NOT NULL DEFAULT ''`,
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
  `CREATE INDEX IF NOT EXISTS idx_reactions_ticker   ON price_reactions (ticker, event_date)`,
  `CREATE INDEX IF NOT EXISTS idx_reactions_pending  ON price_reactions (event_type, complete)`,
  `CREATE INDEX IF NOT EXISTS idx_financials_ticker  ON quarterly_financials (ticker, period_end)`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_date      ON board_meetings (meeting_date)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_ticker     ON market_signals (ticker, event_date DESC)`,
];

// ── Seed companies ────────────────────────────────────────────────────────────

// Single source: src/backend/watchlist.ts. Removing a company there does not
// delete it here; run scripts/update-watchlist.ts for that.
const sql = (s: string) => `'${s.replace(/'/g, "''")}'`;
const SEED_COMPANIES = [
  `INSERT OR IGNORE INTO companies (ticker, name, sector, bse_code) VALUES\n` +
  WATCHLIST.map(c => `    (${sql(c.ticker)}, ${sql(c.name)}, ${sql(c.sector)}, ${sql(c.bseCode)})`).join(',\n'),
];

async function main() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set in .env.local');
    process.exit(1);
  }

  console.log('Endpoint:', BASE);

  console.log('\nCreating tables...');
  await runPipeline(CREATE_TABLES);
  console.log(`  ✓ ${CREATE_TABLES.length} tables (incl. price_reactions, quarterly_financials, board_meetings, market_signals)`);

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
  console.log(`  ✓ ${WATCHLIST.length} watchlist companies (skipped if already present)`);

  console.log('\nDone. Re-runnable at any time — existing data is never overwritten.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
