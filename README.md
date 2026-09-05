# EarningsLens

**Live:** https://earnings-lens.vercel.app/

> AI-powered qualitative earnings call analysis for Indian NSE equities. The layer between raw transcripts and expert conclusions — a category that doesn't exist at any price point in India.

"Robust demand" → "cautious optimism" → earnings miss. EarningsLens catches the language shift 1–2 quarters early.

---

## What It Does

EarningsLens ingests BSE earnings call transcripts, embeds them via Voyage AI or HuggingFace, and surfaces qualitative intelligence that financials alone cannot show:

| Feature | What it answers |
|---------|----------------|
| **Research** | "What did the CFO say about NIM in Q3FY25?" — RAG with citations |
| **Sector Pulse** | "What are the top 5 themes across all BFSI companies this quarter?" |
| **Red Flag Scanner** | "Which companies used evasive language, exceptional charges, or adversarial Q&A?" |
| **Quarter Diff** | "What did management *stop* talking about between Q3 and Q4?" |
| **Guidance Promises** | "Did management deliver on what they promised last quarter?" |
| **Management Quality** | "Is this CFO getting more vague over time?" |
| **Sentiment** | "Is management tone turning negative before the numbers confirm it?" |
| **Keywords** | "When did 'credit costs' start appearing across NBFC transcripts?" |

---

## Architecture

```
Browser (Next.js 14 App Router)
  ├── /              → Overview      (public)
  ├── /research      → Research      (auth required)
  ├── /sentiment     → Sentiment     (auth required)
  ├── /keywords      → Keywords      (auth required)
  ├── /pipeline      → Coverage      (auth required, 2-company free limit)
  ├── /management    → Management    (auth required)
  ├── /promises      → Promises      (auth required)
  ├── /diff          → Quarter Diff  (auth required)
  ├── /redflags      → Red Flags     (auth required)
  ├── /sector        → Sector Pulse  (auth required)
  └── /daily-feed    → Daily Filings (auth required)
        │
        ▼ fetch
Express Backend (port 3001)
  ├── /api/companies      — company registry + BSE discovery
  ├── /api/ingest         — PDF ingestion pipeline
  ├── /api/query          — RAG query endpoint
  ├── /api/sentiment      — sentiment history
  ├── /api/insights       — AI insight generation
  ├── /api/management     — management quality scoring
  ├── /api/promises       — guidance promise extraction + resolution
  ├── /api/redflags       — red flag scanning + site-wide feed
  ├── /api/diff           — quarter-over-quarter transcript diff
  ├── /api/sector         — sector narrative map
  ├── /api/daily-filings  — daily BSE filing scrape + digest
  └── /api/quarters       — quarter index
        │
        ├── Turso (LibSQL)   — structured/relational data
        └── Qdrant           — vector embeddings + semantic search
```

---

## Auto-pipeline on Ingestion

Every time a transcript is ingested, these run automatically (fire-and-forget):

```
POST /api/ingest
  1. Parse speaker turns (CEO / CFO / Analyst / Other)
  2. Chunk (512 tokens, 64 overlap) + embed via Voyage AI or HuggingFace API
  3. Upsert to Qdrant with payload metadata
  4. Groq sentiment classification per chunk → Turso
  5. Extract guidance promises (CEO + CFO) → Turso
  6. Resolve pending promises from prior quarters against new transcript
  7. Scan for red flags (9-category taxonomy) → Turso
  8. Telegram + SendGrid notification
```

---

## Features

### Sector Pulse `/sector` ✦ NEW
- Select any sector (Banking, Technology, NBFC, Conglomerate)
- AI extracts top 5 dominant themes across all companies in the sector for the selected quarter
- Each theme shows which companies are **optimistic** vs **cautious** vs neutral
- Emerging topics: themes that appeared this quarter but were absent 2 quarters ago
- Narrative evolution panel: how sector themes shifted across the last 4 quarters
- Results cached in `sector_narratives` — instant on reload, ~20s first run

### Red Flag Scanner `/redflags` ✦ NEW
- 9-category qualitative risk taxonomy, AI-scanned from every transcript:
  - Exceptional charges / one-time items appearing for first time
  - Management deflecting analyst questions
  - Regulatory / legal language spike
  - Accounting terminology changes (revenue recognition shifts)
  - CEO / CFO leadership change mentioned
  - Compensating language (excessive positivity after bad numbers)
  - Analyst adversarial pressure (same question asked multiple times)
  - Guidance range widening dramatically
  - Capex guidance cut without explanation
- Severity: Low / Medium / High per flag, with verbatim evidence quote
- **Site-wide feed**: all flags detected across all companies in last 7 days
- Auto-runs on every ingestion

### Quarter Diff `/diff` ✦ NEW
- Side-by-side AI comparison of any two quarters for any company
- **Dropped topics**: what management discussed in Q-1 but not in Q (avoidance signal)
- **New topics**: themes that emerged this quarter (new focus or concern)
- **Phrase shifts**: "NIM expansion" → "NIM stabilisation" (framing change)
- **Keyword frequency delta table**: every word ranked by absolute count change (+/− with % change)
- Tone score delta (management confidence composite across quarters)
- AI-generated diff summary (2–3 sentences on what changed and what it signals)

### Guidance Promise Tracker `/promises` ✦ NEW
- AI extracts every forward-looking commitment from CEO/CFO speech
- Per promise: verbatim quote, speaker, category, timeframe, confidence score (1–5), direct language flag
- Auto-resolution: when next quarter is ingested, AI checks each pending promise → `delivered` / `partial` / `missed`
- Delivery heatmap per quarter (color-coded stacked bar)
- Filter by status, category, or quarter
- Categories: Revenue, Margin, Volume, Capex, Hiring, Product, Regulatory, Dividend, Guidance, Other

### Management Quality `/management`
- AI scoring per company per quarter across 3 dimensions (0–100 each):
  - **Confidence** — "we will" vs "we hope to explore"
  - **Transparency** — specific numbers + timeframes vs platitudes
  - **Follow-through** — did current quarter address prior commitments with data?
- Extracts hedging phrases verbatim
- Prior quarter promise list vs current delivery assessment
- Composite score color-coded (green ≥70 / amber ≥50 / red <50)

### Research `/research`
- Natural-language RAG query over all ingested transcripts
- Filter by ticker, quarters, speaker role (CEO / CFO / Analyst)
- Optional Cohere reranking for improved retrieval quality (if `COHERE_API_KEY` set)
- Citations panel: source chunk, speaker, quarter, sentiment score
- No-lookahead mode (`beforeDate`) for historical backtesting
- Every query logged to Turso + Qdrant; Telegram + SendGrid notification

### Sentiment `/sentiment`
- Signed Groq-classified sentiment drift chart per company — positive scores above zero, negative below
- Area chart with green/red gradient split at zero — actual directional movement, not flat confidence
- Multi-ticker toggle; quarter-over-quarter trend visible at a glance

### Keywords `/keywords`
- Track any keyword or phrase frequency across all ingested quarters
- Bar chart per keyword across companies
- Spot emerging themes before they become consensus (e.g. "credit costs", "AI capex")

### Coverage `/pipeline`
- Add companies by NSE ticker or name (auto-discovers from Screener.in)
- Auto-fetches BSE earnings call PDFs via Firecrawl (falls back to raw axios scraping)
- Optional LlamaParse for PDF extraction (falls back to `pdf-parse`)
- Free accounts: 2 companies max (tracked in `user_companies`)
- Telegram + SendGrid notification on discovery + ingestion

### Daily Filings `/daily-feed` ✦ NEW
- Scrapes BSE corporate announcements for every tracked company on a rolling 24h window
- Groq (`llama-3.1-8b-instant`) scores each filing's investor relevance 1–5 and tags a category (earnings / board / investor_meet / press_release / management_change / acquisition / regulatory / other)
- Filings scoring at or above a configurable importance threshold get their PDF fetched and summarized by a second Groq pass — 1–2 sentence summary, key points, sentiment, and "what to watch next"
- Lower-scoring filings are still recorded, just without the PDF fetch — kept lightweight for routine/administrative disclosures
- Telegram digest grouped by ticker, chunked to stay under message limits, deduped against previously-seen filings by PDF URL
- Tracked companies are fully configurable — add or remove tickers via the `companies` table (`/api/companies`); the scraper picks up whatever is currently registered, no code change needed

### Overview `/`
- Company list grouped by sector with inline sentiment badge (latest quarter)
- Stats bar: total companies · quarters processed · coverage %
- Expandable cards with AI-generated insights + Q&A history
- Free, no auth required

---

## What's Stored Where

### Qdrant — `earnings_transcripts` collection

Each ~512-token chunk becomes a vector with payload. Vector dimensions depend on the embedding provider:

| Provider | Model | Dimensions |
|----------|-------|-----------|
| Voyage AI (`VOYAGE_API_KEY` set) | `voyage-finance-2` | 1024 |
| HuggingFace (fallback) | `BAAI/bge-small-en-v1.5` | 384 |

> **Note:** switching providers requires deleting the Qdrant collection and re-ingesting all transcripts — vector dimensions are not compatible.

| Field | Type | Description |
|-------|------|-------------|
| `ticker` | keyword | NSE ticker symbol |
| `quarter` | keyword | Indian fiscal quarter (`Q2FY25`) |
| `fiscalYear` | integer | FY end year |
| `speakerRole` | keyword | `CEO` / `CFO` / `Analyst` / `Other` |
| `speakerName` | string | Parsed speaker name |
| `topic` | string | Inferred topic label |
| `text` | string | Raw chunk text |
| `source` | string | BSE PDF URL |
| `publishedAt` | keyword | ISO date (no-lookahead enforcement) |

Also: `query_log` collection — every RAG query as a vector for semantic dedup.

### Turso — Relational tables

**`companies`** — ticker, name, sector, bse_code  
**`quarter_index`** — ingestion status per ticker + quarter (pdf_url, ingested_at)  
**`sentiment_scores`** — Groq-classified label + score per chunk, averaged per quarter  
**`query_log`** — every RAG query + LLM answer + user rating  
**`insights`** — AI-generated insight cards per ticker  
**`management_scores`** — confidence / transparency / follow_through / composite per quarter  
**`guidance_promises`** — extracted forward-looking commitments, status, resolution note  
**`red_flags`** — flag type, severity, verbatim evidence per ticker + quarter  
**`sector_narratives`** — cached sector theme analysis per sector + quarter  
**`users`** — Clerk user ID + is_premium flag  
**`user_companies`** — per-user company tracking for free-tier limit  
**`daily_filings`** — scraped BSE announcements: title, category, importance score, AI insights, dedup'd by PDF URL  

---

## Auth & Paywall

Powered by **Clerk** (`@clerk/nextjs` v5).

- `/` — public, no auth required
- All other routes — inline Clerk sign-in component (no redirect)
- Free users — 2 company limit in Coverage (enforced at API level, 402 response)
- Premium users — `is_premium = 1` in `users` table (Stripe integration pending)

---

## Notifications

Every significant event triggers Telegram + SendGrid:

| Event | Trigger |
|-------|---------|
| RAG query submitted | `query.route.ts` |
| AI insights generated | `insights.route.ts` |
| BSE PDF discovery complete | `companies.route.ts` |
| Transcript ingested | `ingest.route.ts` |
| Daily BSE filing digest | `daily-filings.graph.ts` |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 App Router, Tailwind CSS, Recharts |
| Auth | Clerk (`@clerk/nextjs` v5) |
| Backend | Express.js (TypeScript) |
| LLM | Groq (`llama-3.1-8b-instant` default) |
| Embeddings | Voyage AI `voyage-finance-2` (1024-dim, primary) · HuggingFace `BAAI/bge-small-en-v1.5` (384-dim, fallback) |
| Sentiment | Groq LLM classification (JSON-mode, financial domain) |
| Reranking | Cohere `rerank-v3.5` (optional, RAG quality improvement) |
| PDF Parsing | LlamaParse (optional) · `pdf-parse` (fallback) |
| Web Scraping | Firecrawl (optional) · axios (fallback) |
| Vector DB | Qdrant Cloud |
| Relational DB | Turso (LibSQL / SQLite edge) |
| Notifications | Telegram Bot API + SendGrid |
| Error Tracking | Sentry (frontend + backend) |
| Background Jobs | Upstash QStash (optional, async ingestion queue) |

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure environment
cp .env.local.example .env.local
# Fill in all variables (see table below)

# 3. Init DB (idempotent — safe to re-run)
npm run db:init

# 4. Run (frontend :8000, backend :3001)
npm run dev
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `TURSO_DATABASE_URL` | LibSQL URL (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `QDRANT_URL` | Qdrant cluster URL |
| `QDRANT_API_KEY` | Qdrant API key |
| `GROQ_API_KEY` | Groq API key |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `CLERK_SECRET_KEY` | Clerk secret key |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Clerk sign-in path (set to `/sign-in`) |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Clerk sign-up path (set to `/sign-up`) |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` | Post sign-in redirect (set to `/`) |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL` | Post sign-up redirect (set to `/`) |
| `HUGGINGFACE_API_TOKEN` | HuggingFace token (embedding fallback) |

### Optional — enhance features

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_MODEL` | `llama-3.1-8b-instant` | Groq model ID |
| `VOYAGE_API_KEY` | — | Voyage AI key — enables `voyage-finance-2` embeddings (1024-dim). Requires Qdrant collection delete + full re-ingest when switching from HuggingFace. |
| `COHERE_API_KEY` | — | Cohere key — enables reranking in RAG. Silently skipped if absent. |
| `LLAMA_CLOUD_API_KEY` | — | LlamaParse key — better PDF extraction. Falls back to `pdf-parse`. |
| `FIRECRAWL_API_KEY` | — | Firecrawl key — better BSE PDF scraping. Falls back to raw axios. |
| `TELEGRAM_ACCESS_TOKEN` | — | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | — | Telegram chat/channel ID |
| `SENDGRID_EMAIL_API_KEY` | — | SendGrid API key |
| `SENDGRID_FROM_EMAIL` | — | Sender email address |
| `SENDGRID_FROM_NAME` | `EarningsLens` | Sender display name |
| `NOTIFICATION_EMAIL` | — | Recipient email address |
| `SENTRY_DSN` | — | Sentry DSN for backend error tracking |
| `NEXT_PUBLIC_SENTRY_DSN` | — | Sentry DSN for frontend error tracking |
| `QSTASH_TOKEN` | — | Upstash QStash token — enables async ingestion queue. Without it, ingestion runs synchronously. |
| `QSTASH_CURRENT_SIGNING_KEY` | — | QStash signing key (worker verification) |
| `QSTASH_NEXT_SIGNING_KEY` | — | QStash next signing key |
| `BACKEND_PUBLIC_URL` | — | Public URL of Express backend — required for QStash to deliver jobs in production |

### Infrastructure

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | Backend URL (used by Next.js frontend) |
| `BACKEND_PORT` | `3001` | Express port (Render sets `PORT` automatically) |
| `FRONTEND_URL` | `http://localhost:8000` | CORS origin for Express — dev frontend runs on `:8000` |

---

## Scripts

```bash
npm run dev              # Start frontend (:8000) + backend (:3001) concurrently
npm run dev:frontend     # Next.js dev server only
npm run dev:backend      # Express backend with hot reload only
npm run build            # Next.js production build (Vercel)
npm run build:backend    # Compile Express backend to dist/ (Render)
npm run start:backend    # Run compiled backend: node dist/backend/server.js
npm run db:init          # Create/migrate all Turso tables (idempotent)
npm run ingest           # Bulk ingest pending queue from quarter_index
```

---

## Deployment

### Frontend — Vercel

1. Import repo on [vercel.com](https://vercel.com) — Next.js auto-detected
2. Add environment variables:
   ```
   NEXT_PUBLIC_API_URL=https://your-backend.onrender.com
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
   CLERK_SECRET_KEY=sk_live_...
   NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
   NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
   NEXT_PUBLIC_SENTRY_DSN=https://...
   ```
3. Deploy — Vercel gives you `earningslens.vercel.app`

### Backend — Render

1. New Web Service → connect repo
2. **Build command:** `npm ci && npm run build:backend`
3. **Start command:** `node dist/backend/server.js`
4. Add environment variables (all required + optional keys, plus):
   ```
   NODE_ENV=production
   FRONTEND_URL=https://earningslens.vercel.app
   BACKEND_PUBLIC_URL=https://your-backend.onrender.com
   ```
5. After first deploy, update `FRONTEND_URL` on Render to match your actual Vercel URL

> Render free tier sleeps after 15 min idle (~30s cold start). Upgrade to Starter ($7/mo) for always-on.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies` | All companies with quarter status + stats |
| POST | `/api/companies/add-and-discover` | Add company + auto-fetch PDFs |
| POST | `/api/ingest` | Ingest transcript text for a quarter |
| POST | `/api/ingest/worker` | QStash worker endpoint (async ingestion) |
| POST | `/api/query` | RAG query (answer + citations + sentiment) |
| GET | `/api/sentiment?ticker=` | Sentiment history per ticker |
| GET | `/api/management?ticker=` | Management quality scores |
| POST | `/api/management/analyze` | Run management quality analysis |
| GET | `/api/promises?ticker=` | Guidance promises (all or by quarter) |
| POST | `/api/promises/extract` | Extract promises from a quarter |
| POST | `/api/promises/resolve` | Resolve pending promises against new quarter |
| GET | `/api/redflags?ticker=` | Red flags per company |
| GET | `/api/redflags/feed?days=7` | Site-wide red flag feed |
| POST | `/api/redflags/scan` | Manual red flag scan for a quarter |
| GET | `/api/diff?ticker=&q1=&q2=` | Quarter diff (keyword delta + semantic) |
| GET | `/api/diff/quarters?ticker=` | Available quarters for diff selector |
| GET | `/api/sector?sector=&quarter=` | Sector narrative (cached or generate) |
| GET | `/api/sector/evolution?sector=` | Last 4 cached sector narratives |
| GET | `/api/sector/sectors` | List all available sectors |
| GET | `/api/sector/quarters?sector=` | Ingested quarters for a sector |
| GET | `/api/insights/:ticker` | Stored insights + Q&A logs |
| POST | `/api/insights/generate/:ticker` | Generate / regenerate AI insights |
| GET | `/api/quarters` | Quarter index |
| GET | `/api/daily-filings` | Daily filings feed (paginated, filterable) |
| GET | `/api/daily-filings/latest-date` | Most recent scrape date |
| GET | `/api/daily-filings/status` | Live scrape stage/progress |
| POST | `/api/daily-filings/run` | Trigger a scrape run (QStash-verified) |
| GET | `/health` | Backend health check |
