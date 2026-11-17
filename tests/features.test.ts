import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  classifyFdaAnnouncement, approvalsFromOpenFda, recallsFromOpenFda, isOrderAnnouncement, extractOrderValue,
  extractClient, summarizeOrders, fyStart, isBadFda, formatFdaMessage, type OrderWin, type FdaEvent,
} from '../src/backend/services/corporate-events.service';
import { parseShareholdingXbrl, compareHoldings, latestPerQuarter, formatHoldingsMessage, type ShareholdingRow } from '../src/backend/services/shareholding.service';
import { ttm, pointAt, range, computeValuation, valuationLines, ordinal } from '../src/backend/services/valuation.service';
import { parseResultsXbrl, quarterFromPeriodEnd } from '../src/backend/services/financials.service';
import { parseLegacyResultFilings } from '../src/backend/services/nse.service';
import { parseCommand, resolveTicker, splitTickerArg, validSecret, webhookSecret, allowedChats, handleUpdate } from '../src/backend/services/bot.service';
import { withLlmSlot, DailyLimitError } from '../src/backend/services/llm';
import { routeAccess } from '../src/backend/middleware/auth';
import type { FinancialRow } from '../src/backend/services/market-store.service';
import { WATCHLIST } from '../src/backend/watchlist';

const fixture = (f: string) => readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const ENV = { ...process.env };
const realFetch = globalThis.fetch;
afterEach(() => { process.env = { ...ENV }; globalThis.fetch = realFetch; });

// ── US FDA ────────────────────────────────────────────────────────────────────

test('FDA classification of real NSE announcement texts', () => {
  const c = (t: string) => classifyFdaAnnouncement('Press Release', t);
  assert.equal(c('Morepen Secures Fourth Consecutive USFDA Inspection with ZeroObservations (NIL 483)'), 'inspection_clean');
  assert.equal(c('Update on US FDA Halol Inspection: Form 483 with 8 observations'), 'form_483');
  assert.equal(c('US FDA classifies Halol as Official Action Indicated (OAI)'), 'oai');
  assert.equal(c('Receipt of Warning Letter from USFDA for Dadra facility'), 'warning_letter');
  assert.equal(c('USFDA issues close-out letter for the warning letter'), 'warning_letter_closeout');
  assert.equal(c('Facility placed under import alert by US FDA'), 'import_alert');
  assert.equal(c('Receipt of Establishment Inspection Report (EIR) from USFDA'), 'eir');
  assert.equal(c('Wockhardt Submits New Drug Application to US FDA for WCK 5222'), 'submission');
  assert.equal(c('Wockhardt receives US FDA approval for Zaynich'), 'approval');
  assert.equal(c('Update on US FDA Halol Inspection'), 'inspection');
  assert.equal(c('Outcome of board meeting'), null);
  assert.ok(isBadFda('oai') && isBadFda('form_483') && !isBadFda('anda_approval'));
});

test('openFDA approvals: original approvals only, sponsor-filtered, in window', () => {
  const apps = [
    { application_number: 'ANDA220722', sponsor_name: 'SUN PHARM', products: [{ brand_name: 'LOPERAMIDE' }],
      submissions: [
        { submission_type: 'ORIG', submission_number: '1', submission_status: 'AP', submission_status_date: '20260930' },
        { submission_type: 'SUPPL', submission_number: '4', submission_status: 'AP', submission_status_date: '20261001' },
      ] },
    { application_number: 'NDA213225', sponsor_name: 'SUN PHARMA GLOBAL', products: [{ brand_name: 'VOBRIG' }],
      submissions: [{ submission_type: 'ORIG', submission_number: '1', submission_status: 'AP', submission_status_date: '20260826' }] },
    { application_number: 'ANDA1', sponsor_name: 'SUNSHINE LAKE', products: [],
      submissions: [{ submission_type: 'ORIG', submission_number: '1', submission_status: 'AP', submission_status_date: '20260901' }] },
    { application_number: 'ANDA2', sponsor_name: 'TARO', products: [],
      submissions: [{ submission_type: 'ORIG', submission_number: '1', submission_status: 'TA', submission_status_date: '20250101' }] },
  ];
  const out = approvalsFromOpenFda('SUNPHARMA', apps, ['SUN PHARM', 'TARO'], '2026-08-01');
  assert.deepEqual(out.map(e => [e.eventType, e.eventDate, e.title]), [
    ['anda_approval', '2026-09-30', 'LOPERAMIDE (ANDA220722)'],
    ['nda_approval', '2026-08-26', 'VOBRIG (NDA213225)'],
  ]);
  const r = recallsFromOpenFda('SUNPHARMA', [{ report_date: '20261014', classification: 'Class III', product_description: 'Tablets',
    recalling_firm: 'SUN PHARMACEUTICAL INDUSTRIES INC', reason_for_recall: 'Failed impurities', recall_number: 'D-0001-2027' }]);
  assert.equal(r[0].eventDate, '2026-10-14');
  assert.equal(r[0].dedupKey, 'fda:recall:D-0001-2027');
  assert.match(formatFdaMessage(out)!, /2 new/);
});

test('every pharma name in the watchlist has FDA identities', () => {
  for (const t of ['WOCKPHARMA', 'MOREPENLAB', 'RUBICON', 'SUNPHARMA']) assert.ok(WATCHLIST.find(c => c.ticker === t)?.fda, t);
});

// ── Orders ────────────────────────────────────────────────────────────────────

test('order values from real Ion Exchange disclosures', () => {
  const omr = 'has been awarded contract from Petroleum Development Oman ... aggregating to OMR 73.46 Million for a period of twenty years (approximately INR 1,730 crores for twenty years).';
  assert.equal(extractOrderValue(omr)!.valueInr, 1730e7);
  const usd = 'awarded an international contract by Hyundai Engineering & Construction Co., Ltd., ... aggregating to USD 52.83 million (approximately INR 503 crore, based on the prevailing exchange rate).';
  assert.equal(extractOrderValue(usd)!.valueInr, 503e7);
  assert.equal(extractOrderValue('awarded contracts from Rayzon Energy aggregating to approximately INR 205 crores for Ultrapure water')!.valueInr, 205e7);
  // USD only: converted at USD_INR
  assert.equal(extractOrderValue('order worth USD 10 million', 90)!.valueInr, 90e7);
  // The order book is not the order
  assert.equal(extractOrderValue('order book stands at Rs 3,000 crore; new order worth Rs 120 crore')!.valueInr, 120e7);
  assert.equal(extractOrderValue('Rs. 45 lakh order')!.valueInr, 45e5);
  assert.equal(extractOrderValue('no amounts here'), null);
});

test('order announcement detection skips court and tax orders', () => {
  assert.ok(isOrderAnnouncement('Bagging/Receiving of orders/contracts', 'informed the Exchange about Bagging/Receiving of orders/contracts'));
  assert.ok(isOrderAnnouncement('Updates', 'The company has secured an order worth Rs 300 crore'));
  assert.ok(!isOrderAnnouncement('Action(s) taken or orders passed', 'GST demand order received'));
  assert.ok(!isOrderAnnouncement('Updates', 'Order of the Hon\'ble NCLT approving the scheme'));
  assert.equal(extractClient('has been awarded contracts from Rayzon Energy Private Limited for Ultra-Pure Water'), 'Rayzon Energy Private Limited');
});

test('order summary: 12-month inflow vs TTM revenue', () => {
  const o = (d: string, v: number | null): OrderWin => ({ ticker: 'X', announcedDate: d, valueInr: v, currency: 'INR', valueText: '', client: '', description: '', method: 'text', sourceUrl: d + v });
  const s = summarizeOrders('X', [o('2026-11-01', 100e7), o('2026-05-01', 50e7), o('2025-11-01', 999e7), o('2026-10-01', null)], 300e7, '2026-11-17');
  assert.equal(s.last12mInr, 150e7);
  assert.equal(s.last12mCount, 3);
  assert.equal(s.unvalued, 1);
  assert.equal(s.coverage, 0.5);
  assert.equal(s.fyToDateInr, 150e7);
  assert.equal(fyStart('2026-03-31'), '2025-04-01');
  assert.equal(fyStart('2026-04-01'), '2026-04-01');
});

// ── Shareholding ──────────────────────────────────────────────────────────────

test('shareholding XBRL (real Morepen Sep-2026 filing)', () => {
  const r = parseShareholdingXbrl(fixture('morepen-shp-2026-09-30.xml'));
  assert.equal(r.promoter, 35.65);
  assert.equal(r.fii, 3.43);
  assert.equal(r.dii, 1.71);
  assert.equal(r.mf, 0);
  assert.equal(r.totalShares, 547953699);
  assert.ok(r.shareholders! > 1000);
});

const holding = (over: Partial<ShareholdingRow>): ShareholdingRow => ({
  ticker: 'X', periodEnd: '2026-09-30', promoter: 50, fii: 10, dii: 20, mf: 10, publicPct: 50, totalShares: 1e8,
  shareholders: 100000, holders: [], filedAt: '', recordId: '1', ...over,
});

test('holding changes flag promoter selling, FII moves and MF entries/exits', () => {
  const prev = holding({ periodEnd: '2026-06-30', holders: [{ name: 'SBI Small Cap Fund', category: 'MF', pct: 2 }] });
  const cur = holding({ promoter: 48.2, fii: 8.5, mf: 10.2, shareholders: 130000,
    holders: [{ name: 'HDFC Mid-Cap Fund', category: 'MF', pct: 1.4 }] });
  const f = compareHoldings(prev, cur);
  assert.deepEqual(f.entered.map(h => h.name), ['HDFC Mid-Cap Fund']);
  assert.deepEqual(f.exited.map(h => h.name), ['SBI Small Cap Fund']);
  assert.ok(f.alerts.some(a => /Promoter down 1\.80 pp/.test(a)));
  assert.ok(f.alerts.some(a => /FII down 1\.50 pp/.test(a)));
  assert.ok(f.alerts.some(a => /Shareholder count up 30%/.test(a)));
  assert.ok(!f.alerts.some(a => /Mutual funds/.test(a)));  // +0.2 pp is under the threshold
  assert.match(formatHoldingsMessage('X', cur, f), /Promoter 48\.20% \(-1\.80\)/);
  assert.deepEqual(compareHoldings(null, cur).alerts, []);
});

test('latestPerQuarter keeps the revision for a quarter', () => {
  const rows = latestPerQuarter([
    { date: '30-SEP-2026', recordId: '10', xbrl: 'a.xml', broadcastDate: '07-OCT-2026 17:26:53' },
    { date: '30-SEP-2026', recordId: '12', xbrl: 'b.xml', broadcastDate: '09-OCT-2026 10:00:00' },
    { date: '30-JUN-2026', recordId: '5', xbrl: 'c.xml' },
  ]);
  assert.deepEqual(rows.map(r => [r.periodEnd, r.xbrl]), [['2026-06-30', 'c.xml'], ['2026-09-30', 'b.xml']]);
});

// ── Valuation ─────────────────────────────────────────────────────────────────

test('results XBRL yields shares, debt and cash for valuation', () => {
  const r = parseResultsXbrl(fixture('morepen-q2fy27-consolidated.xml'))!;
  assert.equal(r.shares, 1095841000 / 2);
  assert.equal(r.debt, 1837746000 + 1211934000);
  assert.equal(r.cash, 1549577000 + 997047000);
});

test('legacy results endpoint rows map to the same filing shape', () => {
  const [f] = parseLegacyResultFilings([{
    seqNumber: '1193025', symbol: 'MOREPENLAB', toDate: '31-Dec-2024', consolidated: 'Consolidated', period: 'Quarterly',
    cumulative: 'Non-cumulative', broadCastDate: '06-Feb-2025 18:51:09', xbrl: 'https://x/INDAS_1.xml', audited: 'Un-Audited',
  }, { seqNumber: '2', toDate: '31-Mar-2024', consolidated: 'Non-Consolidated', period: 'Annual', xbrl: 'y.xml' }]);
  assert.equal(f.periodEnd, '2024-12-31');
  assert.equal(f.basis, 'Consolidated');
  assert.equal(f.filedAt, '2025-02-06 18:51');
});

const q = (periodEnd: string, pat: number, ebitda: number, filedAt: string, extra: Partial<FinancialRow> = {}): FinancialRow => ({
  ticker: 'X', quarter: quarterFromPeriodEnd(periodEnd)!, periodEnd, basis: 'Consolidated', revenue: 100e7, otherIncome: 0,
  financeCosts: 0, depreciation: 0, exceptional: 0, pbt: pat, pat, eps: 1, ebitda, filedAt, seqId: 1, sourceUrl: periodEnd,
  shares: 1e8, debt: null, cash: null, ...extra,
});

const ROWS = [
  q('2025-12-31', 10e7, 20e7, '2026-02-10 18:00'),
  q('2026-03-31', 10e7, 20e7, '2026-05-20 18:00', { debt: 50e7, cash: 10e7 }),
  q('2026-06-30', 10e7, 20e7, '2026-08-10 18:00'),
  q('2026-09-30', 20e7, 30e7, '2026-11-05 18:00', { debt: 40e7, cash: 20e7 }),
];

test('TTM needs four consecutive quarters', () => {
  assert.equal(ttm(ROWS, 'pat'), 50e7);
  assert.equal(ttm(ROWS.slice(1), 'pat'), null);
  assert.equal(ttm([ROWS[0], ROWS[1], ROWS[3], q('2027-03-31', 1, 1, '')], 'pat'), null); // gap
});

test('valuation uses only quarters filed by that date (no look-ahead)', () => {
  // On 2026-11-04 the Sep quarter isn't filed yet: only 3 quarters known → no P/E
  assert.equal(pointAt(ROWS, { date: '2026-11-04', close: 100, prevClose: 100 })!.pe, null);
  // After filing: mcap ₹100 × 10 Cr shares = ₹1,000 Cr; TTM PAT 50 Cr → P/E 20; net debt 20 Cr; TTM EBITDA 90 Cr
  const p = pointAt(ROWS, { date: '2026-11-06', close: 100, prevClose: 100 })!;
  assert.equal(p.marketCap, 1000e7);
  assert.equal(p.pe, 20);
  assert.ok(Math.abs(p.evEbitda! - 1020 / 90) < 1e-9);
});

test('ordinal suffixes', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 42, 53, 98].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '42nd', '53rd', '98th']);
});

test('range percentile and loss handling', () => {
  const r = range([10, 20, 30, 40, null], 30);
  assert.deepEqual([r.min, r.median, r.max, r.percentile], [10, 25, 40, 75]);
  const v = computeValuation('X', [...ROWS.slice(0, 3), q('2026-09-30', -80e7, 30e7, '2026-11-05 18:00')],
    [{ date: '2026-11-10', close: 100, prevClose: 100 }]);
  assert.equal(v.pe.current, null);
  assert.ok(valuationLines(v).some(l => /trailing 12-month loss/.test(l)));
});

// ── Telegram bot ──────────────────────────────────────────────────────────────

const COS = [
  { ticker: 'MOREPENLAB', name: 'Morepen Laboratories Ltd.' }, { ticker: 'SUNPHARMA', name: 'Sun Pharmaceutical Industries Ltd.' },
  { ticker: 'IONEXCHANG', name: 'Ion Exchange (India) Ltd.' }, { ticker: 'IVALUE', name: 'iValue Infosolutions Ltd.' },
];

test('command parsing and partial tickers', () => {
  assert.deepEqual(parseCommand('/brief@EarningsBot morepen'), { name: 'brief', args: 'morepen' });
  assert.deepEqual(parseCommand('/HELP'), { name: 'help', args: '' });
  assert.equal(parseCommand('hello there'), null);
  assert.equal(resolveTicker('morepen', COS), 'MOREPENLAB');
  assert.equal(resolveTicker('sun', COS), 'SUNPHARMA');
  assert.equal(resolveTicker('ion', COS), 'IONEXCHANG');
  assert.equal(resolveTicker('i', COS), null);           // too short
  assert.equal(resolveTicker('margins', COS), null);
  assert.deepEqual(splitTickerArg('sun why did margins fall', COS), { ticker: 'SUNPHARMA', rest: 'why did margins fall' });
  assert.deepEqual(splitTickerArg('why did margins fall', COS), { ticker: null, rest: 'why did margins fall' });
});

test('webhook secret check and owner-only replies', async () => {
  process.env.TELEGRAM_ACCESS_TOKEN = 'tok';
  process.env.TELEGRAM_CHAT_ID = '855753339';
  assert.ok(validSecret(webhookSecret()));
  assert.ok(!validSecret('wrong'));
  assert.ok(!validSecret(undefined));
  assert.match(webhookSecret(), /^[A-Za-z0-9_-]{1,256}$/);
  assert.ok(allowedChats().has('855753339'));

  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  await handleUpdate({ message: { chat: { id: 12345 }, text: '/ask anything at all' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, '12345');
  assert.match(String(sent[0].text), /only answers its owner/);
  await handleUpdate({ message: { chat: { id: 855753339 }, text: 'not a command' } });
  assert.equal(sent.length, 1);
});

test('the webhook route skips Clerk; scorecard routes do not', () => {
  assert.equal(routeAccess('POST', '/telegram/webhook'), 'qstash');
  assert.equal(routeAccess('GET', '/market/valuation'), 'user');
  assert.equal(routeAccess('GET', '/market/fda'), 'user');
});

test('a Groq wait longer than the cap is reported as a daily limit', async () => {
  process.env.GROQ_MAX_WAIT_SECONDS = '60';
  await assert.rejects(
    withLlmSlot(async () => { throw new Error('429 Rate limit reached ... tokens per day ... Please try again in 21m18.3s.'); }),
    (e: unknown) => e instanceof DailyLimitError && Math.round((e as DailyLimitError).waitSeconds) === 1278,
  );
});
