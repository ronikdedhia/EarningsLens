import { runDailyFilingsScrape } from '../graphs/daily-filings.graph';
import { syncSignals, formatSignalsMessage } from './signals.service';
import { syncFinancials } from './financials.service';
import { syncPriceReactions } from './reactions.service';
import { sendResultsBriefs } from './briefs.service';
import { notifyAsync, escapeHtml } from './telegram.service';
import { updateScrapeStage } from '../routes/daily-filings.route';
import { getValuation, valuationLines } from './valuation.service';
import { syncCorporateEvents, reclassifyVagueFdaEvents } from './corporate-events.service';
import { syncShareholding } from './shareholding.service';
import { runAnalysisCatchUp } from './analysis-catchup.service';
import { ensurePrices } from './reactions.service';
import { NIFTY, istDate, addDays, describeFetchError } from './nse.service';
import { listCompanies } from './turso.service';

async function send(html: string | null) {
  if (!html) return;
  try { await notifyAsync(html); } catch (err) { console.error('[jobs] Telegram send failed:', String(err)); }
}

function failureNote(label: string, failures: string[]): string | null {
  if (!failures.length) return null;
  return `⚠️ ${escapeHtml(label)}: ${failures.length} problem(s) — ${failures.slice(0, 6).map(escapeHtml).join('; ')}${failures.length > 6 ? '; …' : ''}`;
}

export interface DailyJobsResult {
  saved:      number;
  important:  number;
  signals:    number;
  financials: number;
  reactions:  number;
  fda?:          number;
  orders?:       number;
  shareholding?: number;
}

let dailyInFlight: Promise<DailyJobsResult> | null = null;

/**
 * 16:00 IST job. Each step runs even if an earlier one failed, and each step's
 * failures are reported in Telegram instead of disappearing into logs.
 */
export function runDailyJobs(targetDate?: string): Promise<DailyJobsResult> {
  if (dailyInFlight) return dailyInFlight;
  dailyInFlight = (async () => {
    const result: DailyJobsResult = { saved: 0, important: 0, signals: 0, financials: 0, reactions: 0 };

    try {
      Object.assign(result, await runDailyFilingsScrape(targetDate));
    } catch (err) {
      console.error('[jobs] filings scrape failed:', err);
      await send(`⚠️ Daily filings scrape failed: ${escapeHtml(String((err as Error).message ?? err).slice(0, 200))}`);
    }

    updateScrapeStage('signals', 'insider trades, SAST, pledges, bulk/block deals');
    try {
      const s = await syncSignals({ sinceDays: 7 });
      result.signals = s.added.length;
      await send(formatSignalsMessage(s.added));
      await send(failureNote('Insider/deal fetch', s.failures));
    } catch (err) {
      console.error('[jobs] signals failed:', err);
    }

    updateScrapeStage('financials', 'results XBRL');
    try {
      const f = await syncFinancials();
      result.financials = f.stored;
      for (const m of f.messages) {
        // Valuation goes with every result: is the quarter already priced in?
        const v = await getValuation(m.ticker).then(valuationLines).catch(() => [] as string[]);
        await send(v.length ? `${m.message}\n\n<b>Valuation</b>\n${v.map(l => `  ${escapeHtml(l)}`).join('\n')}` : m.message);
      }
      await send(failureNote('Results fetch', f.failures));
    } catch (err) {
      console.error('[jobs] financials failed:', err);
    }

    updateScrapeStage('fda-orders', 'US FDA events and order wins');
    try {
      const c = await syncCorporateEvents({ sinceDays: 7 });
      await reclassifyVagueFdaEvents(5).catch(() => 0);
      result.fda = c.fda.length;
      result.orders = c.orders.length;
      for (const m of c.messages) await send(m);
      await send(failureNote('FDA/orders fetch', c.failures));
    } catch (err) {
      console.error('[jobs] FDA/orders failed:', err);
    }

    updateScrapeStage('shareholding', 'quarterly shareholding patterns');
    try {
      const s = await syncShareholding();
      result.shareholding = s.stored;
      for (const m of s.messages) await send(m);
      await send(failureNote('Shareholding fetch', s.failures));
    } catch (err) {
      console.error('[jobs] shareholding failed:', err);
    }

    updateScrapeStage('analysis', 'promises and red flags for quarters still missing them');
    try {
      const a = await runAnalysisCatchUp(Number(process.env.ANALYSIS_CATCHUP_PER_DAY) || 3);
      if (a.done.length) console.log('[jobs] analysis catch-up:', a.done.join(', '), `(${a.remaining} left)`);
    } catch (err) {
      console.error('[jobs] analysis catch-up failed:', err);
    }

    // Keep every company's prices current: the web server can't reach NSE, so
    // /val and the Scorecard read what this job stores.
    updateScrapeStage('prices', 'daily closes');
    try {
      const today = istDate(new Date());
      const from = addDays(today, -730);
      const failures: string[] = [];
      for (const t of [NIFTY, ...(await listCompanies()).map(c => c.ticker)]) {
        await ensurePrices(t, from, today).catch(err => failures.push(`${t}: ${describeFetchError(err)}`));
      }
      await send(failureNote('Price data', failures));
    } catch (err) {
      console.error('[jobs] prices failed:', err);
    }

    updateScrapeStage('reactions', 'price moves after events');
    try {
      const r = await syncPriceReactions();
      result.reactions = r.updated;
      await send(failureNote('Price data', r.failures));
    } catch (err) {
      console.error('[jobs] reactions failed:', err);
    }

    return result;
  })().finally(() => { dailyInFlight = null; });
  return dailyInFlight;
}

let eveningInFlight: Promise<{ sent: string[]; failures: string[] }> | null = null;

/** 19:00 IST job: briefs for results meetings tomorrow. */
export function runEveningJobs(): Promise<{ sent: string[]; failures: string[] }> {
  if (eveningInFlight) return eveningInFlight;
  eveningInFlight = (async () => {
    const r = await sendResultsBriefs();
    await send(failureNote('Results calendar', r.failures));
    return r;
  })().finally(() => { eveningInFlight = null; });
  return eveningInFlight;
}
