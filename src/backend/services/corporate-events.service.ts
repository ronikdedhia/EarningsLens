import axios from 'axios';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { db, listCompanies } from './turso.service';
import { escapeHtml } from './telegram.service';
import { fetchNseAnnouncements, parseNseDateTime, describeFetchError, istDate, addDays, type NseAnnouncement } from './nse.service';
import { fetchPdfText } from '../utils/pdf';
import { chatModel, withLlmSlot, DailyLimitError } from './llm';
import { crore, buildQuarterViews, preferredViews } from './financials.service';
import { listFinancials } from './market-store.service';
import { watchlistEntry } from '../watchlist';

// ── FDA classification (pure) ─────────────────────────────────────────────────

export type FdaEventType =
  | 'warning_letter' | 'warning_letter_closeout' | 'import_alert' | 'oai' | 'form_483' | 'inspection_clean'
  | 'eir' | 'approval' | 'submission' | 'inspection' | 'fda_other'
  | 'anda_approval' | 'anda_tentative' | 'nda_approval' | 'recall';

const FDA_MENTION = /\b(us\s?-?fda|u\.\s?s\.\s?fda|usfda|food\s+(?:and|&)\s+drug\s+administration|fda)\b/i;

/** What an NSE announcement says about the US FDA, or null if it says nothing. */
export function classifyFdaAnnouncement(category: string, text: string): FdaEventType | null {
  const t = `${category} ${text}`;
  if (!FDA_MENTION.test(t)) return null;
  if (/close[\s-]?out letter/i.test(t)) return 'warning_letter_closeout';
  if (/warning letter/i.test(t)) return 'warning_letter';
  if (/import alert/i.test(t)) return 'import_alert';
  if (/\bOAI\b|official action indicated/i.test(t)) return 'oai';
  // "Zero Observations", "ZeroObservations (NIL 483)", "no 483", "NAI"
  if (/\b(zero|nil|no)\s*(form\s*)?(483|observations?)|\bNAI\b|no action indicated/i.test(t)) return 'inspection_clean';
  if (/\b483\b|observations?/i.test(t)) return 'form_483';
  if (/\bEIR\b|establishment inspection report|\bVAI\b|voluntary action indicated/i.test(t)) return 'eir';
  if (/approv/i.test(t)) return 'approval';
  const APP = String.raw`(n?da|bla|snda|sbla|anda|new drug application|biologics license application|abbreviated new drug application)`;
  if (new RegExp(String.raw`\b(submits?|submission|filed|files|accepts?|acceptance|accepted)\b.*\b${APP}\b|\b${APP}\b.*\b(submi|accept|fil)`, 'i').test(t)) return 'submission';
  if (/inspect|audit/i.test(t)) return 'inspection';
  return 'fda_other';
}

export const FDA_LABELS: Record<FdaEventType, string> = {
  warning_letter: 'Warning letter', warning_letter_closeout: 'Warning letter closed out', import_alert: 'Import alert',
  oai: 'OAI (official action indicated)', form_483: 'Form 483 observations', inspection_clean: 'Inspection, zero observations',
  eir: 'EIR received', approval: 'Approval (company disclosure)', submission: 'Application filed/accepted',
  inspection: 'Inspection', fda_other: 'FDA update',
  anda_approval: 'ANDA approval', anda_tentative: 'ANDA tentative approval', nda_approval: 'NDA approval', recall: 'Recall',
};

const BAD_FDA: Set<FdaEventType> = new Set(['warning_letter', 'import_alert', 'oai', 'form_483', 'recall']);
export const isBadFda = (t: string) => BAD_FDA.has(t as FdaEventType);

export interface FdaEvent {
  ticker:       string;
  eventType:    FdaEventType;
  eventDate:    string;
  eventMinutes: number | null;
  source:       'nse' | 'openfda';
  title:        string;
  detail:       string;
  url:          string;
  dedupKey:     string;
}

const FDA_TYPES_FOR_LLM = ['warning_letter', 'warning_letter_closeout', 'import_alert', 'oai', 'form_483',
  'inspection_clean', 'eir', 'approval', 'submission', 'inspection', 'fda_other'] as const;

const FdaPdfSchema = z.object({
  eventType: z.enum(FDA_TYPES_FOR_LLM),
  summary:   z.string(),
});

/**
 * "Update on US FDA inspection" says nothing on its own; the PDF says whether it
 * was a 483, an OAI or a clean result. Only called for those vague cases.
 */
async function classifyFdaPdf(pdfText: string): Promise<{ type: FdaEventType; summary: string } | null> {
  // Main model: the cheap one labelled NDA filings as OAI. Only a few calls a month.
  const model = chatModel('main', { temperature: 0, maxTokens: 200 }).withStructuredOutput(FdaPdfSchema);
  const body = pdfText.replace(/\s+/g, ' ');
  const start = Math.max(0, body.search(/dear sir|sub(ject)?\s*:/i));
  const r = await withLlmSlot(() => model.invoke([new HumanMessage(
    'An Indian pharma company disclosed this to the stock exchange. Pick the ONE label for the NEW US FDA event it reports, ' +
    'ignoring background history it repeats:\n' +
    '- warning_letter: FDA issued a warning letter\n- warning_letter_closeout: FDA closed out a warning letter\n' +
    '- import_alert: products placed on (or removed from) an import alert\n' +
    '- oai: a facility was classified "Official Action Indicated" — use ONLY if the text says OAI / Official Action Indicated\n' +
    '- form_483: an inspection ended with Form 483 observations\n- inspection_clean: an inspection ended with zero observations / NAI\n' +
    '- eir: an Establishment Inspection Report was received, or the facility was classified VAI\n' +
    '- approval: FDA approved a product (ANDA, NDA, BLA, sNDA)\n' +
    '- submission: the company filed an application or FDA accepted one for review (not an approval)\n' +
    '- inspection: an inspection started or is ongoing, outcome not given\n- fda_other: anything else\n' +
    'summary: under 20 words; keep facility, product and number of observations if given.\n\n' +
    body.slice(start, start + 5000),
  )]));
  return { type: r.eventType, summary: r.summary };
}

export async function fdaFromAnnouncementWithPdf(ticker: string, a: NseAnnouncement): Promise<FdaEvent | null> {
  const e = fdaFromAnnouncement(ticker, a);
  if (!e || !['inspection', 'fda_other'].includes(e.eventType)) return e;
  try {
    const r = await classifyFdaPdf(await fetchPdfText(a.pdfUrl));
    if (r) return { ...e, eventType: r.type, title: r.summary || e.title, detail: `${e.detail} · read from the PDF` };
  } catch { /* keep the text-based reading */ }
  return e;
}

export function fdaFromAnnouncement(ticker: string, a: NseAnnouncement): FdaEvent | null {
  const type = classifyFdaAnnouncement(a.category, a.text);
  if (!type) return null;
  const when = parseNseDateTime(a.filedAt);
  return {
    ticker, eventType: type, eventDate: when?.date ?? a.filingDate, eventMinutes: when?.minutes ?? null,
    source: 'nse', title: a.text.slice(0, 300) || a.category, detail: a.category, url: a.pdfUrl,
    dedupKey: `fda:nse:${a.pdfUrl}`,
  };
}

const ymd = (s: string | undefined) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '');

/** openFDA drugsfda results → original approvals (and tentative approvals) in the window. */
export function approvalsFromOpenFda(ticker: string, results: Array<Record<string, any>>, sponsors: string[], fromIso: string): FdaEvent[] {
  const out: FdaEvent[] = [];
  for (const app of results) {
    const sponsor = String(app.sponsor_name ?? '');
    if (!sponsors.some(s => sponsor.toUpperCase().startsWith(s.toUpperCase()))) continue;
    const appNo = String(app.application_number ?? '');
    const products = (app.products ?? []) as Array<Record<string, any>>;
    const name = [...new Set(products.map(p => p.brand_name).filter(Boolean))].slice(0, 2).join(', ') || appNo;
    const strength = products[0]?.active_ingredients?.map((i: any) => `${i.name} ${i.strength}`).join(', ') ?? '';
    for (const s of (app.submissions ?? []) as Array<Record<string, any>>) {
      const date = ymd(s.submission_status_date);
      if (s.submission_type !== 'ORIG' || !['AP', 'TA'].includes(s.submission_status) || date < fromIso) continue;
      const type: FdaEventType = appNo.startsWith('NDA') ? 'nda_approval' : s.submission_status === 'TA' ? 'anda_tentative' : 'anda_approval';
      out.push({
        ticker, eventType: type, eventDate: date, eventMinutes: null, source: 'openfda',
        title: `${name} (${appNo})`, detail: [sponsor, strength].filter(Boolean).join(' · '),
        url: `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${appNo.replace(/\D/g, '')}`,
        dedupKey: `fda:openfda:${appNo}:${s.submission_type}:${s.submission_number}:${s.submission_status}`,
      });
    }
  }
  return out;
}

export function recallsFromOpenFda(ticker: string, results: Array<Record<string, any>>): FdaEvent[] {
  return results.map(r => ({
    ticker, eventType: 'recall' as const, eventDate: ymd(r.report_date), eventMinutes: null, source: 'openfda' as const,
    title: `${r.classification ?? ''} recall: ${String(r.product_description ?? '').slice(0, 140)}`.trim(),
    detail: `${r.recalling_firm ?? ''} · ${String(r.reason_for_recall ?? '').slice(0, 200)}`,
    url: 'https://www.accessdata.fda.gov/scripts/ires/index.cfm',
    dedupKey: `fda:recall:${r.recall_number ?? `${r.recalling_firm}:${r.report_date}:${r.product_description}`}`,
  })).filter(e => e.eventDate);
}

async function openFda(path: string, search: string, limit = 100): Promise<Array<Record<string, any>>> {
  try {
    const { data } = await axios.get(`https://api.fda.gov/${path}`, { params: { search, limit }, timeout: 30_000 });
    return data?.results ?? [];
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return []; // openFDA's "no matches"
    throw err;
  }
}

// ── Order classification and value extraction (pure) ──────────────────────────

const NOT_A_CONTRACT = /\b(court|tribunal|nclt|nclat|sebi|arbitra|penalt|show cause|gst|income tax|demand order|assessment order|order of the hon)/i;

export function isOrderAnnouncement(category: string, text: string): boolean {
  const cat = category.toLowerCase();
  if (/bagging|receiving of orders|orders\/contracts|award of (order|contract)/.test(cat)) return true;
  const t = `${category} ${text}`;
  if (NOT_A_CONTRACT.test(t)) return false;
  return /\b(letter of award|loa\b|work order|purchase order|order (worth|valued|value|amounting|for)|bagged|secured (an? )?(order|contract)|received (an? )?(order|contract)|award(ed)? (of )?(an? )?(order|contract))/i.test(t);
}

const UNIT: Record<string, number> = {
  crore: 1e7, crores: 1e7, cr: 1e7, 'cr.': 1e7, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5,
  million: 1e6, mn: 1e6, millions: 1e6, billion: 1e9, bn: 1e9,
};

export interface OrderValue {
  valueInr: number;
  currency: 'INR' | 'USD' | 'EUR';
  text:     string;
}

/**
 * The order's value from an announcement. Prefers amounts introduced by
 * "worth / valued / value of / amounting / order of", and skips the total order
 * book, which is often quoted in the same sentence.
 */
export function extractOrderValue(text: string, usdInr = Number(process.env.USD_INR) || 88, eurInr = Number(process.env.EUR_INR) || 95): OrderValue | null {
  const re = /(₹|rs\.?|inr|usd|us\s?\$|\$|eur|€)\s*([\d,]+(?:\.\d+)?)\s*(crores?|cr\.?|lakhs?|lacs?|millions?|mn|billion|bn)?\b|([\d,]+(?:\.\d+)?)\s*(crores?|cr\.?|lakhs?|lacs?|millions?|mn)\b/gi;
  // Other currencies (OMR 73.46 Million): no rate here, so skip and use the INR
  // equivalent the company usually states alongside.
  const OTHER_CCY = /\b(omr|aed|sar|qar|kwd|bhd|gbp|jpy|cny|sgd|aud|cad|chf|zar|egp|ngn|kes|bdt|lkr|npr)\s*$/i;
  const candidates: Array<OrderValue & { score: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const cur = (m[1] ?? '').toLowerCase();
    const rawNum = (m[2] ?? m[4] ?? '').replace(/,/g, '');
    const unit = (m[3] ?? m[5] ?? '').toLowerCase();
    const n = parseFloat(rawNum);
    if (!Number.isFinite(n) || n <= 0) continue;
    let mult = UNIT[unit] ?? UNIT[unit.replace(/\.$/, '')];
    if (!mult) {
      if (n < 1e6) continue; // a bare "Rs 500" with no unit is not an order value
      mult = 1;
    }
    const currency: OrderValue['currency'] = /usd|\$/.test(cur) ? 'USD' : /eur|€/.test(cur) ? 'EUR' : 'INR';
    const fx = currency === 'USD' ? usdInr : currency === 'EUR' ? eurInr : 1;
    const before = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
    if (!m[1] && OTHER_CCY.test(before)) continue;
    // Only the words right before the amount: "order book of Rs 3,000 crore; new order worth Rs 120 crore"
    if (/(order\s*book|backlog|cumulative|total orders?)[^;.]{0,25}$/.test(before)) continue;
    let score = 0;
    if (/(worth|valued|value of|value|amounting|aggregating|order of|contract of|for an amount|consideration)(\s+(to|of|about|around|approx\w*\.?|approximately|up to))*\W*$/.test(before)) score += 2;
    if (/order|contract|award|loa/.test(before)) score += 1;
    // The company's own INR figure beats our conversion of a foreign amount.
    if (currency === 'INR' && m[1]) score += 1;
    // "USD 52.83 million (approximately INR 503 crore)": the company's own conversion wins.
    if (/approx\w*\.?\s*$|approximately\s*$/.test(before) && currency === 'INR') score += 3;
    if (!m[1]) score -= 1;
    candidates.push({ valueInr: n * mult * fx, currency, text: m[0].trim(), score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const { score: _score, ...best } = candidates[0];
  return best;
}

const OrderSchema = z.object({
  isNewOrder:  z.boolean(),
  value:       z.number().nullable(),
  unit:        z.string().nullable(),
  currency:    z.string().nullable(),
  client:      z.string().nullable(),
  description: z.string().nullable(),
});

async function llmOrderValue(pdfText: string): Promise<{ value: OrderValue | null; client: string; description: string } | null> {
  const model = chatModel('fast', { temperature: 0, maxTokens: 250 }).withStructuredOutput(OrderSchema);
  const r = await withLlmSlot(() => model.invoke([new HumanMessage(
    'From this Indian stock-exchange disclosure, extract the newly received order or contract. ' +
    'value: the number as written; unit: crore, lakh, million, billion or null; currency: INR, USD or EUR; ' +
    'client: who placed the order; description: under 15 words. isNewOrder false if this is not a new order.\n\n' +
    pdfText.slice(0, 6000),
  )]));
  if (!r.isNewOrder) return null;
  const text = r.value != null ? `${r.currency ?? 'INR'} ${r.value} ${r.unit ?? ''}` : '';
  return { value: text ? extractOrderValue(text.replace(/^INR/, 'Rs')) : null, client: r.client ?? '', description: r.description ?? '' };
}

/** "from M/s Larsen & Toubro Limited for ..." → "Larsen & Toubro Limited" */
export function extractClient(text: string): string {
  const m = text.match(/\bfrom\s+(?:m\/s\.?\s*)?([A-Z][A-Za-z0-9&.,()'\- ]{2,90}?)(?=\s+(?:for|to|worth|valued|amounting|of rs|of inr|of ₹)\b|[.;]|$)/);
  return m ? m[1].replace(/[,\s]+$/, '').trim() : '';
}

// ── Store ─────────────────────────────────────────────────────────────────────

async function fdaKnown(key: string): Promise<boolean> {
  const { rows } = await db().execute({ sql: 'SELECT 1 FROM fda_events WHERE dedup_key = ? LIMIT 1', args: [key] });
  return rows.length > 0;
}

export async function insertFdaEvent(e: FdaEvent): Promise<boolean> {
  const r = await db().execute({
    sql: `INSERT OR IGNORE INTO fda_events (ticker, event_type, event_date, event_minutes, source, title, detail, url, dedup_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [e.ticker, e.eventType, e.eventDate, e.eventMinutes, e.source, e.title, e.detail, e.url, e.dedupKey],
  });
  return r.rowsAffected > 0;
}

export async function listFdaEvents(opts: { ticker?: string; sinceIso?: string; limit?: number } = {}): Promise<Array<FdaEvent & { id: number }>> {
  const where: string[] = []; const args: (string | number)[] = [];
  if (opts.ticker) { where.push('ticker = ?'); args.push(opts.ticker); }
  if (opts.sinceIso) { where.push('event_date >= ?'); args.push(opts.sinceIso); }
  args.push(opts.limit ?? 200);
  const { rows } = await db().execute({
    sql: `SELECT * FROM fda_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY event_date DESC, id DESC LIMIT ?`, args,
  });
  return rows.map(r => ({
    id: Number(r.id), ticker: String(r.ticker), eventType: r.event_type as FdaEventType, eventDate: String(r.event_date),
    eventMinutes: r.event_minutes == null ? null : Number(r.event_minutes), source: r.source as FdaEvent['source'],
    title: String(r.title), detail: String(r.detail), url: String(r.url), dedupKey: String(r.dedup_key),
  }));
}

export interface OrderWin {
  id?:           number;
  ticker:        string;
  announcedDate: string;
  valueInr:      number | null;
  currency:      string;
  valueText:     string;
  client:        string;
  description:   string;
  method:        'text' | 'pdf' | 'llm' | 'none';
  sourceUrl:     string;
}

async function orderKnown(url: string): Promise<boolean> {
  const { rows } = await db().execute({ sql: 'SELECT 1 FROM order_wins WHERE source_url = ? LIMIT 1', args: [url] });
  return rows.length > 0;
}

async function insertOrder(o: OrderWin): Promise<boolean> {
  const r = await db().execute({
    sql: `INSERT OR IGNORE INTO order_wins (ticker, announced_date, value_inr, currency, value_text, client, description, method, source_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [o.ticker, o.announcedDate, o.valueInr, o.currency, o.valueText, o.client, o.description, o.method, o.sourceUrl],
  });
  return r.rowsAffected > 0;
}

export async function listOrders(ticker: string, sinceIso?: string): Promise<OrderWin[]> {
  const { rows } = await db().execute({
    sql: `SELECT * FROM order_wins WHERE ticker = ? ${sinceIso ? 'AND announced_date >= ?' : ''} ORDER BY announced_date DESC`,
    args: sinceIso ? [ticker, sinceIso] : [ticker],
  });
  return rows.map(r => ({
    id: Number(r.id), ticker: String(r.ticker), announcedDate: String(r.announced_date),
    valueInr: r.value_inr == null ? null : Number(r.value_inr), currency: String(r.currency), valueText: String(r.value_text),
    client: String(r.client), description: String(r.description), method: r.method as OrderWin['method'], sourceUrl: String(r.source_url),
  }));
}

// ── Order-book summary ────────────────────────────────────────────────────────

export interface OrderSummary {
  ticker:        string;
  last12mInr:    number;
  last12mCount:  number;
  unvalued:      number;     // announcements in the window with no extractable value
  fyToDateInr:   number;
  ttmRevenue:    number | null;
  coverage:      number | null;   // last-12-month inflow ÷ TTM revenue
}

/** Indian FY start (1 April) for an ISO date. */
export function fyStart(iso: string): string {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return `${m >= 4 ? y : y - 1}-04-01`;
}

export function summarizeOrders(ticker: string, orders: OrderWin[], ttmRevenue: number | null, today: string): OrderSummary {
  const yearAgo = addDays(today, -365);
  const fy = fyStart(today);
  const window = orders.filter(o => o.announcedDate > yearAgo);
  const last12mInr = window.reduce((s, o) => s + (o.valueInr ?? 0), 0);
  return {
    ticker,
    last12mInr,
    last12mCount: window.length,
    unvalued:     window.filter(o => o.valueInr == null).length,
    fyToDateInr:  orders.filter(o => o.announcedDate >= fy).reduce((s, o) => s + (o.valueInr ?? 0), 0),
    ttmRevenue,
    coverage:     ttmRevenue && ttmRevenue > 0 ? last12mInr / ttmRevenue : null,
  };
}

export async function orderSummary(ticker: string): Promise<OrderSummary> {
  const rows = preferredViews(buildQuarterViews(await listFinancials(ticker))).map(v => v.row).slice(-4);
  const ttmRevenue = rows.length === 4 && rows.every(r => r.revenue != null) ? rows.reduce((s, r) => s + (r.revenue as number), 0) : null;
  return summarizeOrders(ticker, await listOrders(ticker), ttmRevenue, istDate(new Date()));
}

export function formatOrderMessage(o: OrderWin, s: OrderSummary): string {
  const value = o.valueInr != null ? crore(o.valueInr) + (o.currency !== 'INR' ? ` (${escapeHtml(o.valueText)})` : '') : 'value not stated';
  const lines = [
    `📦 <b>${escapeHtml(o.ticker)}</b> order: ${value}${o.client ? ` — ${escapeHtml(o.client)}` : ''}`,
  ];
  if (o.description) lines.push(`  ${escapeHtml(o.description.slice(0, 200))}`);
  lines.push(`  Last 12 months: ${s.last12mCount} orders, ${crore(s.last12mInr)}` +
    (s.coverage != null ? ` = ${s.coverage.toFixed(2)}× TTM revenue (${crore(s.ttmRevenue)})` : '') +
    (s.unvalued ? `; ${s.unvalued} without a stated value` : ''));
  return lines.join('\n');
}

export function formatFdaMessage(events: FdaEvent[]): string | null {
  if (!events.length) return null;
  const bad = events.filter(e => isBadFda(e.eventType)).length;
  const lines = [`💊 <b>US FDA</b> — ${events.length} new${bad ? `, ${bad} ⚠️` : ''}`];
  for (const e of events.slice(0, 15)) {
    lines.push(`  ${isBadFda(e.eventType) ? '🔴' : '🟢'} <b>${escapeHtml(e.ticker)}</b> ${escapeHtml(FDA_LABELS[e.eventType])}: ${escapeHtml(e.title.slice(0, 160))} <i>${escapeHtml(e.eventDate)}</i>`);
  }
  if (events.length > 15) lines.push(`  … ${events.length - 15} more`);
  return lines.join('\n');
}

/**
 * NSE FDA events stored as a vague "inspection"/"FDA update" because the PDF
 * read failed (usually Groq's daily cap). Retried a few a day by the 16:00 job.
 */
export async function reclassifyVagueFdaEvents(limit = 5): Promise<number> {
  const { rows } = await db().execute({
    sql: `SELECT id, url FROM fda_events WHERE source = 'nse' AND event_type IN ('inspection','fda_other')
            AND detail NOT LIKE '%read from the PDF%' ORDER BY event_date DESC LIMIT ?`,
    args: [limit],
  });
  let fixed = 0;
  for (const r of rows) {
    try {
      const c = await classifyFdaPdf(await fetchPdfText(String(r.url)));
      if (!c) continue;
      await db().execute({
        sql: `UPDATE fda_events SET event_type = ?, title = CASE WHEN ? != '' THEN ? ELSE title END,
                detail = detail || ' · read from the PDF' WHERE id = ?`,
        args: [c.type, c.summary, c.summary, r.id],
      });
      // The label changed, so the stored reaction must be recomputed under the new one.
      await db().execute({ sql: `DELETE FROM price_reactions WHERE event_type = 'fda' AND event_id = ?`, args: [r.id] });
      fixed++;
    } catch (err) {
      if (err instanceof DailyLimitError) break;
    }
  }
  return fixed;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export interface CorporateEventsResult {
  fda:      FdaEvent[];
  orders:   OrderWin[];
  messages: string[];
  failures: string[];
}

export async function syncCorporateEvents(opts: { sinceDays?: number; tickers?: string[]; announce?: boolean } = {}): Promise<CorporateEventsResult> {
  const companies = await listCompanies();
  const tickers = opts.tickers ?? companies.map(c => c.ticker);
  const today = new Date();
  const days = opts.sinceDays ?? 7;
  const fromIso = addDays(istDate(today), -days);
  const out: CorporateEventsResult = { fda: [], orders: [], messages: [], failures: [] };
  const newOrders: OrderWin[] = [];

  for (const ticker of tickers) {
    const fdaCfg = watchlistEntry(ticker)?.fda;

    // NSE announcements in ≤ 90-day pieces (one request serves FDA and orders)
    let announcements: NseAnnouncement[] = [];
    try {
      for (let start = fromIso; start <= istDate(today); start = addDays(start, 91)) {
        const end = addDays(start, 90) < istDate(today) ? addDays(start, 90) : istDate(today);
        announcements.push(...await fetchNseAnnouncements(ticker, new Date(`${start}T12:00:00+05:30`), new Date(`${end}T12:00:00+05:30`)));
      }
    } catch (err) {
      out.failures.push(`${ticker} announcements: ${describeFetchError(err)}`);
      announcements = [];
    }

    if (fdaCfg) {
      for (const a of announcements) {
        if (!classifyFdaAnnouncement(a.category, a.text) || await fdaKnown(`fda:nse:${a.pdfUrl}`)) continue;
        const e = await fdaFromAnnouncementWithPdf(ticker, a);
        if (e && await insertFdaEvent(e)) out.fda.push(e);
      }
      try {
        const window = `[${fromIso.replace(/-/g, '')} TO ${istDate(today).replace(/-/g, '')}]`;
        if (fdaCfg.sponsors.length) {
          const q = fdaCfg.sponsors.map(s => `sponsor_name:"${s}"`).join(' OR ');
          const apps = await openFda('drug/drugsfda.json', `(${q}) AND submissions.submission_status_date:${window}`);
          for (const e of approvalsFromOpenFda(ticker, apps, fdaCfg.sponsors, fromIso)) if (await insertFdaEvent(e)) out.fda.push(e);
        }
        if (fdaCfg.firms.length) {
          const q = fdaCfg.firms.map(f => `recalling_firm:"${f}"`).join(' OR ');
          const recalls = await openFda('drug/enforcement.json', `(${q}) AND report_date:${window}`);
          for (const e of recallsFromOpenFda(ticker, recalls)) if (await insertFdaEvent(e)) out.fda.push(e);
        }
      } catch (err) {
        out.failures.push(`${ticker} openFDA: ${describeFetchError(err)}`);
      }
    }

    for (const a of announcements.filter(x => isOrderAnnouncement(x.category, x.text))) {
      if (await orderKnown(a.pdfUrl)) continue;
      let value = extractOrderValue(a.text);
      let method: OrderWin['method'] = value ? 'text' : 'none';
      let client = extractClient(a.text);
      let description = a.text.replace(/^.*?informed the exchange (about|regarding)\s*/i, '').slice(0, 200);
      if (!value) {
        try {
          const pdf = await fetchPdfText(a.pdfUrl);
          value = extractOrderValue(pdf.slice(0, 5000));
          if (value) { method = 'pdf'; client ||= extractClient(pdf.slice(0, 5000)); }
          else {
            const llm = await llmOrderValue(pdf).catch(() => null);
            if (llm === null) continue; // the model read it as not a new order
            if (llm.value) { value = llm.value; method = 'llm'; }
            client ||= llm.client;
            description = llm.description || description;
          }
        } catch { /* PDF unavailable: keep it, unvalued */ }
      }
      const o: OrderWin = {
        ticker, announcedDate: a.filingDate, valueInr: value?.valueInr ?? null, currency: value?.currency ?? 'INR',
        valueText: value?.text ?? '', client, description, method, sourceUrl: a.pdfUrl,
      };
      if (await insertOrder(o)) { out.orders.push(o); newOrders.push(o); }
    }
  }

  if (opts.announce !== false) {
    const fdaMsg = formatFdaMessage(out.fda);
    if (fdaMsg) out.messages.push(fdaMsg);
    for (const o of newOrders) out.messages.push(formatOrderMessage(o, await orderSummary(o.ticker)));
  }
  return out;
}
