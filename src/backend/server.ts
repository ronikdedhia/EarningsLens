import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), process.env.NODE_ENV === 'production' ? '.env' : '.env.local') });
process.setMaxListeners(0);
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { ingestRouter }    from './routes/ingest.route';
import { queryRouter }     from './routes/query.route';
import { sentimentRouter } from './routes/sentiment.route';
import { quartersRouter }  from './routes/quarters.route';
import { companiesRouter } from './routes/companies.route';
import { queriesRouter }   from './routes/queries.route';
import { insightsRouter }    from './routes/insights.route';
import { managementRouter }  from './routes/management.route';
import { promisesRouter }    from './routes/promises.route';
import { redflagsRouter }   from './routes/redflags.route';
import { diffRouter }       from './routes/diff.route';
import { sectorRouter }     from './routes/sector.route';
import { keepaliveRouter, registerKeepaliveSchedule, registerDailyReportSchedule, registerDailyFilingsSchedule, registerNewsletterSchedule, registerRefreshSchedule, setDailyReportHandler, pingQdrantOnce } from './routes/keepalive.route';
import { sendWeeklyNewsletter, parseNewsletterCron } from './services/newsletter.service';
import { dailyFilingsRouter } from './routes/daily-filings.route';
import { runRefreshAll } from './routes/companies.route';
import { requireAuth } from './middleware/auth';
import { marketRouter } from './routes/market.route';
import { registerBriefsSchedule } from './routes/keepalive.route';
import { runDailyJobs, runEveningJobs } from './services/jobs.service';
import { modelId } from './services/llm';
import { getSystemStats, getTodayQueryCount } from './services/turso.service';

const app = express();

app.use(cors({ origin: (process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/$/, '') }));
app.use(express.json({
  limit: '10mb',
  verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf.toString(); },
}));

app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.originalUrl}`);
  next();
});

// Clerk session required on /api/* except the public read routes and the
// QStash-signed routes listed in middleware/auth.ts.
app.use('/api', requireAuth);

app.use('/api/ingest',    ingestRouter);
app.use('/api/query',     queryRouter);
app.use('/api/sentiment', sentimentRouter);
app.use('/api/quarters',  quartersRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/queries',   queriesRouter);
app.use('/api/insights',    insightsRouter);
app.use('/api/management',  managementRouter);
app.use('/api/promises',    promisesRouter);
app.use('/api/redflags',    redflagsRouter);
app.use('/api/diff',        diffRouter);
app.use('/api/sector',      sectorRouter);
app.use('/api/keepalive',      keepaliveRouter);
app.use('/api/daily-filings', dailyFilingsRouter);
app.use('/api/market',        marketRouter);

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Public deploy check (npm run check-deploy). Reports which commit is running
// and whether required settings exist — never their values.
const STARTED_AT = new Date().toISOString();
app.get('/version', (_, res) => res.json({
  service:   'backend',
  commit:    process.env.RENDER_GIT_COMMIT ?? null,
  startedAt: STARTED_AT,
  models:    { main: modelId('main'), fast: modelId('fast') },
  configured: Object.fromEntries(
    ['GROQ_API_KEY', 'CLERK_SECRET_KEY', 'TURSO_DATABASE_URL', 'QDRANT_URL', 'VOYAGE_API_KEY',
     'TELEGRAM_ACCESS_TOKEN', 'TELEGRAM_CHAT_ID', 'QSTASH_CURRENT_SIGNING_KEY', 'FRONTEND_URL']
      .map(k => [k, !!process.env[k]]),
  ),
}));


export async function sendDailyReport() {
  await pingQdrantOnce(); // one daily Qdrant ping alongside the report
  try {
    await Promise.all([getSystemStats(), getTodayQueryCount()]);
  } catch {
    // ignore
  }
}

const PORT = process.env.PORT ?? process.env.BACKEND_PORT ?? 3001;
app.listen(PORT, async () => {
  console.log(`Express backend → http://localhost:${PORT}`);

  setDailyReportHandler(sendDailyReport);
  registerKeepaliveSchedule().catch(console.error);

  // QStash and node-cron used to both fire every job. When the server was awake
  // that meant two daily scrapes and two newsletters at the same minute. Now
  // exactly one scheduler runs: QStash when configured (it can wake a sleeping
  // Render instance), node-cron otherwise.
  const useQstash = !!(process.env.QSTASH_TOKEN && process.env.BACKEND_PUBLIC_URL);

  if (useQstash) {
    await Promise.all([
      registerDailyReportSchedule(),
      registerDailyFilingsSchedule(),
      registerNewsletterSchedule(),
      registerRefreshSchedule(),
      registerBriefsSchedule(),
    ]).catch(err => console.error('[qstash] schedule registration failed:', err));
    console.log('[cron] QStash schedules active; node-cron jobs not registered');
    return;
  }

  // Daily health report at 14:00 IST (08:30 UTC)
  cron.schedule('30 8 * * *', sendDailyReport, { timezone: 'UTC' });
  console.log('[cron] Daily report scheduled at 14:00 IST');

  // Daily jobs at 16:00 IST (10:30 UTC): filings, insider/deal signals, results, price reactions
  cron.schedule('30 10 * * *', async () => {
    try {
      const r = await runDailyJobs();
      console.log('[cron] Daily jobs:', r);
    } catch (err) {
      console.error('[cron] Daily jobs failed:', err);
    }
  }, { timezone: 'UTC' });
  console.log('[cron] Daily jobs scheduled at 16:00 IST');

  // Results-day briefs at 19:00 IST (13:30 UTC) for meetings tomorrow
  cron.schedule('30 13 * * *', () => {
    runEveningJobs().catch(err => console.error('[cron] Results briefs failed:', err));
  }, { timezone: 'UTC' });
  console.log('[cron] Results briefs scheduled at 19:00 IST');

  // Weekly refresh — Friday 12:00 IST (06:30 UTC) — checks all companies for new quarters
  cron.schedule('30 6 * * 5', () => {
    runRefreshAll().catch(err => console.error('[cron] Weekly refresh failed:', err));
  }, { timezone: 'UTC' });
  console.log('[cron] Weekly refresh scheduled at Friday 12:00 IST');

  // Weekly newsletter — Friday at NEWSLETTER_SEND_TIME IST (default 09:00)
  cron.schedule(parseNewsletterCron(), async () => {
    try {
      await sendWeeklyNewsletter();
    } catch (err) {
      console.error('[cron] Weekly newsletter failed:', err);
    }
  }, { timezone: 'UTC' });
  console.log(`[cron] Weekly newsletter scheduled (${process.env.NEWSLETTER_SEND_TIME ?? '09:00'} IST Friday)`);
});
