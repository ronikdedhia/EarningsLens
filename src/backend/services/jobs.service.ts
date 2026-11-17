import { runDailyFilingsScrape } from '../graphs/daily-filings.graph';
import { syncSignals, formatSignalsMessage } from './signals.service';
import { syncFinancials } from './financials.service';
import { syncPriceReactions } from './reactions.service';
import { sendResultsBriefs } from './briefs.service';
import { notifyAsync, escapeHtml } from './telegram.service';
import { updateScrapeStage } from '../routes/daily-filings.route';

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
      for (const m of f.messages) await send(m.message);
      await send(failureNote('Results fetch', f.failures));
    } catch (err) {
      console.error('[jobs] financials failed:', err);
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
