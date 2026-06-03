import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), process.env.NODE_ENV === 'production' ? '.env' : '.env.local') });
import * as Sentry from '@sentry/node';
Sentry.init({ dsn: process.env.SENTRY_DSN ?? '', tracesSampleRate: 0.1 });
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
import { keepaliveRouter, registerKeepaliveSchedule } from './routes/keepalive.route';
import { notify } from './services/telegram.service';
import { getSystemStats, getTodayQueryCount } from './services/turso.service';

const app = express();

app.use(cors({ origin: (process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/$/, '') }));
app.use(express.json({ limit: '10mb' }));

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
app.use('/api/keepalive',   keepaliveRouter);

app.get('/health', (_, res) => res.json({ status: 'ok' }));

Sentry.setupExpressErrorHandler(app);

async function sendDailyReport() {
  try {
    const [stats, todayQueries] = await Promise.all([getSystemStats(), getTodayQueryCount()]);
    const date = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    notify(
      `📊 *EarningsLens Daily Report — ${date}*\n\n` +
      `🏢 Companies tracked: *${stats.companies}* (${stats.sectors} sectors)\n` +
      `📄 Transcripts ingested: *${stats.ingested}* · pending: ${stats.pending}\n` +
      `🧠 AI Insights stored: *${stats.aiInsights}*\n` +
      `🔎 Queries today: *${todayQueries}*\n\n` +
      `✅ Server is alive and running`
    );
  } catch (err) {
    notify(`⚠️ *EarningsLens* daily report failed: \`${String(err).slice(0, 200)}\``);
  }
}

const PORT = process.env.PORT ?? process.env.BACKEND_PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`Express backend → http://localhost:${PORT}`);
  registerKeepaliveSchedule().catch(console.error);
  // Daily health report at 11:00 IST (05:30 UTC)
  cron.schedule('30 5 * * *', sendDailyReport, { timezone: 'UTC' });
  console.log('[cron] Daily Telegram report scheduled at 08:00 IST');
});
