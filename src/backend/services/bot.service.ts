import { createHmac, timingSafeEqual } from 'crypto';
import { escapeHtml, sendTo, telegramApi } from './telegram.service';
import { listCompanies, type Company } from './turso.service';
import { listSignals, listBoardMeetings, listFinancials } from './market-store.service';
import { formatSignalsMessage } from './signals.service';
import { assembleBrief, buildBrief } from './briefs.service';
import { buildQuarterViews, preferredViews, summaryLines } from './financials.service';
import { getValuation, valuationLines } from './valuation.service';
import { listShareholding, compareHoldings, formatHoldingsMessage } from './shareholding.service';
import { listFdaEvents, formatFdaMessage, listOrders, orderSummary, FDA_LABELS } from './corporate-events.service';
import { istDate, addDays } from './nse.service';
import { crore } from './financials.service';
import { runRAGQuery } from '../rag/chain';

// ── Security ──────────────────────────────────────────────────────────────────

/**
 * Telegram sends this value in X-Telegram-Bot-Api-Secret-Token on every webhook
 * call. Derived from the bot token unless TELEGRAM_WEBHOOK_SECRET is set, so
 * there's no extra secret to manage. Only [A-Za-z0-9_-] is allowed.
 */
export function webhookSecret(): string {
  if (process.env.TELEGRAM_WEBHOOK_SECRET) return process.env.TELEGRAM_WEBHOOK_SECRET;
  return createHmac('sha256', process.env.TELEGRAM_ACCESS_TOKEN ?? '').update('earningslens-webhook').digest('hex').slice(0, 48);
}

export function validSecret(header: string | undefined): boolean {
  const expected = Buffer.from(webhookSecret());
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Only these chats get answers: /ask spends Groq tokens. */
export function allowedChats(): Set<string> {
  return new Set([process.env.TELEGRAM_CHAT_ID, ...(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '').split(',')]
    .map(s => (s ?? '').trim()).filter(Boolean));
}

// ── Parsing (pure) ────────────────────────────────────────────────────────────

export interface Command { name: string; args: string }

/** "/brief@MyBot morepen" → { name: 'brief', args: 'morepen' } */
export function parseCommand(text: string): Command | null {
  const m = text.trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() } : null;
}

/** Exact symbol, symbol prefix, or a word of the company name: "morepen", "sun", "ion". */
export function resolveTicker(word: string, companies: Pick<Company, 'ticker' | 'name'>[]): string | null {
  const w = word.trim().toUpperCase().replace(/[^A-Z0-9&]/g, '');
  if (w.length < 2) return null;
  const exact = companies.find(c => c.ticker === w);
  if (exact) return exact.ticker;
  const prefix = companies.filter(c => c.ticker.startsWith(w));
  if (prefix.length === 1) return prefix[0].ticker;
  const byName = companies.filter(c => c.name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).some(t => t.startsWith(w)));
  return byName.length === 1 ? byName[0].ticker : null;
}

/** "/ask morepen why did margins fall" → ticker + question; ticker optional. */
export function splitTickerArg(args: string, companies: Pick<Company, 'ticker' | 'name'>[]): { ticker: string | null; rest: string } {
  const [first, ...rest] = args.split(/\s+/);
  const ticker = first ? resolveTicker(first, companies) : null;
  return ticker ? { ticker, rest: rest.join(' ') } : { ticker: null, rest: args };
}

export const HELP = [
  '<b>EarningsLens bot</b>',
  '/brief TICKER — results-day brief',
  '/results TICKER — latest quarter with QoQ/YoY',
  '/val TICKER — P/E, EV/EBITDA vs 2-year range',
  '/holdings TICKER — promoter/FII/DII/MF changes',
  '/orders TICKER — order wins, last 12 months',
  '/fda [TICKER] — US FDA events, last 90 days',
  '/signals [TICKER] — insider trades and deals, last 14 days',
  '/ask [TICKER] question — ask the transcripts',
  '/watchlist — tracked companies',
  '',
  'Tickers can be partial: <code>/val morepen</code>, <code>/brief sun</code>.',
].join('\n');

export const COMMANDS = [
  ['brief', 'Results-day brief for a company'], ['results', 'Latest quarter with QoQ/YoY'],
  ['val', 'Valuation vs 2-year range'], ['holdings', 'Shareholding changes'], ['orders', 'Order wins'],
  ['fda', 'US FDA events'], ['signals', 'Insider trades and deals'], ['ask', 'Ask the transcripts'],
  ['watchlist', 'Tracked companies'], ['help', 'All commands'],
].map(([command, description]) => ({ command, description }));

// ── Handlers ──────────────────────────────────────────────────────────────────

async function needTicker(args: string, companies: Company[], usage: string): Promise<string> {
  const t = resolveTicker(args.split(/\s+/)[0] ?? '', companies);
  if (!t) throw new UserError(`Which company? ${usage}\nTracked: ${companies.map(c => c.ticker).join(', ')}`);
  return t;
}

class UserError extends Error {}

export async function handleCommand(cmd: Command): Promise<string> {
  const companies = await listCompanies();
  const today = istDate(new Date());

  switch (cmd.name) {
    case 'start':
    case 'help':
      return HELP;

    case 'watchlist':
      return `<b>Tracked</b>\n${companies.map(c => `  ${escapeHtml(c.ticker)} — ${escapeHtml(c.name)}`).join('\n')}`;

    case 'brief': {
      const t = await needTicker(cmd.args, companies, 'Usage: /brief MOREPENLAB');
      const next = (await listBoardMeetings(today, addDays(today, 60))).find(m => m.ticker === t);
      return buildBrief(await assembleBrief(t, next?.meetingDate ?? 'next results (date not announced)', next?.description ?? ''));
    }

    case 'results': {
      const t = await needTicker(cmd.args, companies, 'Usage: /results SUNPHARMA');
      const views = preferredViews(buildQuarterViews(await listFinancials(t)));
      const v = views[views.length - 1];
      if (!v) return `No results stored for ${escapeHtml(t)} yet.`;
      const val = valuationLines(await getValuation(t, { fetchPrices: false }));
      return [`📊 <b>${escapeHtml(t)}</b> ${escapeHtml(v.row.quarter)} (${v.row.basis})`,
        ...summaryLines(v).map(l => `  ${escapeHtml(l)}`),
        ...(val.length ? ['', ...val.map(l => `  ${escapeHtml(l)}`)] : [])].join('\n');
    }

    case 'val':
    case 'valuation': {
      const t = await needTicker(cmd.args, companies, 'Usage: /val IVALUE');
      const lines = valuationLines(await getValuation(t));
      return lines.length ? `💰 <b>${escapeHtml(t)}</b> valuation\n${lines.map(l => `  ${escapeHtml(l)}`).join('\n')}`
        : `Not enough data for ${escapeHtml(t)} yet (needs shares outstanding and four quarters).`;
    }

    case 'holdings': {
      const t = await needTicker(cmd.args, companies, 'Usage: /holdings MOREPENLAB');
      const rows = await listShareholding(t);
      const cur = rows[rows.length - 1];
      if (!cur) return `No shareholding data for ${escapeHtml(t)} yet.`;
      return formatHoldingsMessage(t, cur, compareHoldings(rows[rows.length - 2] ?? null, cur));
    }

    case 'orders': {
      const t = await needTicker(cmd.args, companies, 'Usage: /orders IONEXCHANG');
      const [orders, s] = await Promise.all([listOrders(t, addDays(today, -365)), orderSummary(t)]);
      if (!orders.length) return `No order announcements for ${escapeHtml(t)} in the last 12 months.`;
      return [
        `📦 <b>${escapeHtml(t)}</b> orders, last 12 months: ${s.last12mCount}, ${crore(s.last12mInr)}` +
          (s.coverage != null ? ` = ${s.coverage.toFixed(2)}× TTM revenue` : ''),
        ...orders.slice(0, 12).map(o => `  · ${o.announcedDate} ${o.valueInr != null ? crore(o.valueInr) : 'n/a'}${o.client ? ` — ${escapeHtml(o.client.slice(0, 60))}` : ''}`),
      ].join('\n');
    }

    case 'fda': {
      const { ticker } = splitTickerArg(cmd.args, companies);
      const events = await listFdaEvents({ ticker: ticker ?? undefined, sinceIso: addDays(today, -90), limit: 30 });
      return formatFdaMessage(events)?.replace(/ new/, ' in 90 days') ?? `No FDA events in the last 90 days${ticker ? ` for ${ticker}` : ''}.`;
    }

    case 'signals': {
      const { ticker } = splitTickerArg(cmd.args, companies);
      const sig = await listSignals({ ticker: ticker ?? undefined, sinceIso: addDays(today, -14), limit: 60 });
      return formatSignalsMessage(sig)?.replace(/ new/, ' in 14 days') ?? `No insider trades or deals in the last 14 days${ticker ? ` for ${ticker}` : ''}.`;
    }

    case 'ask': {
      const { ticker, rest } = splitTickerArg(cmd.args, companies);
      if (rest.length < 5) return 'Usage: /ask [TICKER] your question, e.g. <code>/ask ionexchang what is the order book guidance?</code>';
      const r = await runRAGQuery(rest, { ticker: ticker ?? undefined, topK: 10 });
      const sources = [...new Set(r.citations.map(c => `${c.ticker} ${c.quarter}`))].slice(0, 6);
      return `🔎 ${ticker ? `<b>${escapeHtml(ticker)}</b> · ` : ''}${escapeHtml(rest)}\n\n${escapeHtml(r.answer.slice(0, 3500))}` +
        (sources.length ? `\n\n<i>Sources: ${escapeHtml(sources.join(', '))}</i>` : '');
    }

    default:
      return `Unknown command /${escapeHtml(cmd.name)}.\n\n${HELP}`;
  }
}

// ── Webhook entry ─────────────────────────────────────────────────────────────

interface Update { message?: { chat?: { id?: number }; text?: string; from?: { id?: number } } }

export async function handleUpdate(update: Update): Promise<void> {
  const chatId = update.message?.chat?.id;
  const text = update.message?.text;
  if (chatId == null || !text) return;
  const cmd = parseCommand(text);
  if (!cmd) return; // plain chat messages are ignored
  if (!allowedChats().has(String(chatId))) {
    await sendTo(chatId, 'This bot only answers its owner.');
    return;
  }
  try {
    await sendTo(chatId, await handleCommand(cmd));
  } catch (err) {
    const msg = err instanceof UserError ? err.message : `Something went wrong: ${String((err as Error).message ?? err).slice(0, 200)}`;
    await sendTo(chatId, escapeHtml(msg)).catch(() => {});
  }
}

/** Last registration outcome, shown on /version. */
export const botStatus: { webhook: string; at: string | null } = { webhook: 'not attempted', at: null };

/** Points Telegram at /api/telegram/webhook and publishes the command menu. Idempotent. */
export async function registerWebhook(): Promise<void> {
  const base = process.env.BACKEND_PUBLIC_URL?.replace(/\/$/, '');
  if (!process.env.TELEGRAM_ACCESS_TOKEN || !base) {
    botStatus.webhook = 'skipped: TELEGRAM_ACCESS_TOKEN or BACKEND_PUBLIC_URL missing';
    return;
  }
  const url = `${base}/api/telegram/webhook`;
  // Outbound network can be unavailable for the first seconds after a Render boot.
  for (let attempt = 1; ; attempt++) {
    try {
      // Re-set every boot: cheap, and refreshes the secret if TELEGRAM_WEBHOOK_SECRET changed.
      await telegramApi('setWebhook', { url, secret_token: webhookSecret(), allowed_updates: ['message'], drop_pending_updates: false });
      await telegramApi('setMyCommands', { commands: COMMANDS });
      botStatus.webhook = `registered → ${url}`;
      botStatus.at = new Date().toISOString();
      console.log(`[bot] webhook registered → ${url}`);
      return;
    } catch (err) {
      botStatus.webhook = `failed (attempt ${attempt}): ${String((err as Error).message ?? err).slice(0, 150)}`;
      botStatus.at = new Date().toISOString();
      if (attempt >= 6) throw err;
      await new Promise(r => setTimeout(r, 10_000 * attempt));
    }
  }
}
