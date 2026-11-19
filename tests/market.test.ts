import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseResultsXbrl, quarterFromPeriodEnd, computeEbitda, buildQuarterViews, preferredViews,
  latestFilings, relevantPromises, formatResultsMessage, summaryLines,
} from '../src/backend/services/financials.service';
import {
  parseInsiderXbrl, insiderDirection, insiderSignals, dealSignals, pledgeSignal, sastSignals,
  isNotable, formatSignalsMessage,
} from '../src/backend/services/signals.service';
import { baseIndex, compound, computeReaction, summarize } from '../src/backend/services/reactions.service';
import { buildBrief } from '../src/backend/services/briefs.service';
import {
  parseNseDateTime, parseBoardMeetings, parseSecurityHistory, chainCloses, parseResultFilings, addDays,
  type DailyBar,
} from '../src/backend/services/nse.service';
import type { FinancialRow, ReactionRow, SignalRow } from '../src/backend/services/market-store.service';
import type { GuidancePromiseRow } from '../src/backend/services/turso.service';
import { WATCHLIST, REMOVED_TICKERS, STATIC_BSE_CODES } from '../src/backend/watchlist';

const fixture = (f: string) => readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

// ── Watchlist ─────────────────────────────────────────────────────────────────

test('watchlist has the requested changes and no overlap with removals', () => {
  const tickers = WATCHLIST.map(c => c.ticker);
  for (const t of ['MOREPENLAB', 'RUBICON', 'IVALUE', 'VENKEYS', 'SUNPHARMA', 'WOCKPHARMA', 'IONEXCHANG', 'TRUALT']) {
    assert.ok(tickers.includes(t), t);
  }
  for (const t of ['RPOWER', 'SAMMAANCAP', 'SHAKTIPUMP', 'MMTC', 'HDFCBANK', 'RELIANCE', 'PSPPROJECT']) assert.ok(!tickers.includes(t), t);
  assert.equal(REMOVED_TICKERS.filter(t => tickers.includes(t)).length, 0);
  assert.equal(STATIC_BSE_CODES.MOREPENLAB, '500288');
  assert.ok(WATCHLIST.every(c => /^\d{6}$/.test(c.bseCode)));
});

// ── Dates ─────────────────────────────────────────────────────────────────────

test('parseNseDateTime handles the formats NSE mixes', () => {
  assert.deepEqual(parseNseDateTime('09-Nov-2026 17:58:09'), { date: '2026-11-09', minutes: 17 * 60 + 58 });
  assert.deepEqual(parseNseDateTime('23-FEB-2026'), { date: '2026-02-23', minutes: null });
  assert.deepEqual(parseNseDateTime('2026-11-13 23:28:54'), { date: '2026-11-13', minutes: 23 * 60 + 28 });
  assert.deepEqual(parseNseDateTime('31-Mar-2021, 18-38'), { date: '2021-03-31', minutes: 18 * 60 + 38 });
  assert.equal(parseNseDateTime('garbage'), null);
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
});

// ── Financials ────────────────────────────────────────────────────────────────

test('results XBRL (real Morepen Q2FY27 filing) parses to full-rupee figures', () => {
  const r = parseResultsXbrl(fixture('morepen-q2fy27-consolidated.xml'))!;
  assert.equal(r.quarter, 'Q2FY27');
  assert.equal(r.periodEnd, '2026-09-30');
  assert.equal(r.basis, 'Consolidated');
  assert.equal(r.revenue, 7465019000);
  assert.equal(r.pat, 888947000);
  assert.equal(r.eps, 1.62);
  // 1165395000 - 0 + 51924000 + 100699000 - 86852000
  assert.equal(r.ebitda, 1231166000);
});

test('quarterFromPeriodEnd follows the Indian fiscal year', () => {
  assert.equal(quarterFromPeriodEnd('2026-06-30'), 'Q1FY27');
  assert.equal(quarterFromPeriodEnd('2026-09-30'), 'Q2FY27');
  assert.equal(quarterFromPeriodEnd('2026-12-31'), 'Q3FY27');
  assert.equal(quarterFromPeriodEnd('2027-03-31'), 'Q4FY27');
  assert.equal(quarterFromPeriodEnd('2026-08-31'), null);
});

test('computeEbitda needs PBT, finance costs and depreciation', () => {
  assert.equal(computeEbitda({ pbt: 100, financeCosts: 10, depreciation: 20, otherIncome: 5, exceptional: -30 }), 155);
  assert.equal(computeEbitda({ pbt: 100, financeCosts: null, depreciation: 20, otherIncome: 5, exceptional: 0 }), null);
});

const fin = (periodEnd: string, revenue: number, ebitda: number, pat: number, basis: FinancialRow['basis'] = 'Consolidated'): FinancialRow => ({
  ticker: 'X', quarter: quarterFromPeriodEnd(periodEnd)!, periodEnd, basis, revenue, otherIncome: 0, financeCosts: 0,
  depreciation: 0, exceptional: 0, pbt: pat, pat, eps: 1, ebitda, filedAt: '', seqId: 1, sourceUrl: '',
});

test('QoQ and YoY compare against the right quarters and the same basis', () => {
  const views = buildQuarterViews([
    fin('2025-09-30', 100e7, 20e7, 10e7),
    fin('2026-06-30', 110e7, 22e7, 11e7),
    fin('2026-09-30', 121e7, 30.25e7, 12e7),
    fin('2026-09-30', 999e7, 1e7, 1e7, 'Standalone'),
  ]);
  const v = preferredViews(views).find(x => x.row.periodEnd === '2026-09-30')!;
  assert.equal(v.row.basis, 'Consolidated');
  assert.equal(v.qoq!.vsQuarter, 'Q1FY27');
  assert.equal(v.yoy!.vsQuarter, 'Q2FY26');
  assert.ok(Math.abs(v.yoy!.revenuePct! - 21) < 1e-9);
  assert.ok(Math.abs(v.qoq!.revenuePct! - 10) < 1e-9);
  assert.ok(Math.abs(v.yoy!.ebitdaMarginBps! - 500) < 1e-6); // 20% → 25%
  const lines = summaryLines(v);
  assert.match(lines[0], /Revenue ₹121 Cr \(\+21\.0% YoY, \+10\.0% QoQ\)/);
  assert.match(lines[1], /margin 25\.0% \(\+500 bp YoY\)/);
});

test('latestFilings keeps the revision over the original', () => {
  const base = { symbol: 'X', periodEnd: '2026-09-30', basis: 'Consolidated' as const, audited: '', filedAt: '', xbrlUrl: 'a.xml' };
  const out = latestFilings([{ ...base, seqId: 10, revision: false }, { ...base, seqId: 12, revision: true }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].seqId, 12);
});

test('parseResultFilings reads NSE integrated-filing rows and ignores "no data"', () => {
  assert.deepEqual(parseResultFilings({ data: 0, msg: 'no data found' }), []);
  const [f] = parseResultFilings({ data: [{
    seq_Id: '205006', symbol: 'MOREPENLAB', qe_Date: '30-SEP-2026', consolidated: 'Consolidated', audited: 'Un-Audited',
    type_Sub: 'Original', creation_Date: '27-Oct-2026 18:39:22', broadcast_Date: '27-Oct-2026 18:39:09',
    xbrl: 'https://nsearchives.nseindia.in/corporate/xbrl/INTEGRATED_FILING_INDAS_1747091_27102026063922_WEB.xml',
  }] });
  assert.equal(f.periodEnd, '2026-09-30');
  assert.equal(f.filedAt, '2026-10-27 18:39');
});

const promise = (quarterPromised: string, category: string, quote = 'We will grow revenue 20% this year'): GuidancePromiseRow => ({
  id: 1, ticker: 'X', quarterPromised, speaker: 'CEO', category, verbatimQuote: quote, timeframe: 'FY27',
  confidenceScore: 4, directLanguage: true, status: 'pending', resolutionNote: '', resolvedInQuarter: '', createdAt: '',
} as GuidancePromiseRow);

test('results message lists numeric promises from earlier quarters only', () => {
  const ps = [promise('Q1FY27', 'Revenue'), promise('Q2FY27', 'Margin'), promise('Q1FY27', 'Hiring'), promise('Q1FY25', 'Revenue')];
  const rel = relevantPromises(ps, 'Q2FY27');
  assert.deepEqual(rel.map(p => `${p.quarterPromised}:${p.category}`), ['Q1FY27:Revenue']);
  const v = buildQuarterViews([fin('2026-09-30', 121e7, 30e7, 12e7)])[0];
  const msg = formatResultsMessage('X&Y', v, rel);
  assert.match(msg, /<b>X&amp;Y<\/b> results Q2FY27/);
  assert.match(msg, /Management guided:/);
});

// ── Signals ───────────────────────────────────────────────────────────────────

test('insider XBRL (real 360ONE filing) yields one row per disclosure', () => {
  const txns = parseInsiderXbrl(fixture('insider-360one.xml'));
  assert.ok(txns.length >= 1);
  assert.equal(txns[0].person, 'Navin Narmadeshwar Upadhyaya');
  assert.equal(txns[0].quantity, 5000);
  const [s] = insiderSignals('360ONE', '4353', '13-Nov-2026 23:28:54', txns);
  assert.equal(s.direction, 'pledge_release');
  assert.equal(s.eventDate, '2026-11-13');
  assert.equal(s.eventMinutes, 23 * 60 + 28);
  assert.equal(s.dedupKey, 'insider:4353:0');
});

test('insiderDirection maps NSE transaction types', () => {
  assert.equal(insiderDirection('Buy'), 'buy');
  assert.equal(insiderDirection('Sell'), 'sell');
  assert.equal(insiderDirection('Pledge Create'), 'pledge');
  assert.equal(insiderDirection('Pledge Revoke', 'Pledge Release'), 'pledge_release');
  assert.equal(insiderDirection('Invocation of pledge'), 'pledge_invoked');
});

test('deal rows: only this symbol, value = qty × price, deduped by content', () => {
  const rows = [
    { BD_DT_DATE: '23-FEB-2026', BD_SYMBOL: 'MOREPENLAB', BD_CLIENT_NAME: 'NK SECURITIES', BD_BUY_SELL: 'BUY', BD_QTY_TRD: 6404880, BD_TP_WATP: 45.07 },
    { BD_DT_DATE: '23-FEB-2026', BD_SYMBOL: 'OTHER', BD_CLIENT_NAME: 'Z', BD_BUY_SELL: 'SELL', BD_QTY_TRD: 1, BD_TP_WATP: 1 },
  ];
  const out = dealSignals('bulk_deal', 'MOREPENLAB', rows);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].value! - 6404880 * 45.07) < 1e-3);
  assert.equal(out[0].eventDate, '2026-02-23');
  assert.ok(isNotable(out[0]));
});

test('pledge snapshot compares with the previous one', () => {
  const row = { shp: '30-Sep-2026', percSharesPledged: '3.9', numSharesPledged: '20384197', totPromoterHolding: '195371588' };
  const first = pledgeSignal('MOREPENLAB', row, null, '2026-11-17')!;
  assert.equal(first.direction, 'snapshot');
  assert.match(first.detail, /^3\.9% of shares pledged \(10\.4% of promoter holding\)/);
  const up = pledgeSignal('MOREPENLAB', { ...row, shp: '31-Dec-2026', percSharesPledged: '5.2' }, first, '2027-02-01')!;
  assert.equal(up.direction, 'increase');
  assert.ok(isNotable(up));
  assert.notEqual(first.dedupKey, up.dedupKey);
});

test('SAST rows map promoter acquisitions and sales', () => {
  const [buy, sell] = sastSignals('X', [
    { acqSaleType: 'Acquisition', acquirerName: 'Promo Pvt Ltd', promoterType: 'Y', noOfShareAcq: '1000', timestamp: '31-Mar-2021 18:38', application_no: '1', regType: 'Reg29(2)' },
    { acqSaleType: 'Sale', acquirerName: 'Fund', promoterType: 'N', noOfShareSale: '500', noOfShareAcq: null, timestamp: '01-Apr-2021 10:00', application_no: '2' },
  ]);
  assert.equal(buy.direction, 'buy');
  assert.equal(buy.category, 'Promoter');
  assert.equal(sell.direction, 'sell');
  assert.equal(sell.quantity, 500);
});

test('promoter selling is notable, a designated person buying is not', () => {
  const s = (category: string, direction: string): SignalRow => ({
    ticker: 'X', signalType: 'insider', eventDate: '2026-11-01', eventMinutes: null, party: 'P', category,
    direction, quantity: 1, value: 1, price: 1, detail: '', dedupKey: `${category}${direction}`,
  });
  assert.ok(isNotable(s('Promoter Group', 'sell')));
  assert.ok(!isNotable(s('Designated Person', 'buy')));
  const msg = formatSignalsMessage([s('Promoter Group', 'sell'), s('Designated Person', 'buy')])!;
  assert.match(msg, /2 new, 1 ⚠️/);
  assert.equal(formatSignalsMessage([]), null);
});

// ── Prices and reactions ──────────────────────────────────────────────────────

test('parseSecurityHistory prefers EQ series and keeps NSE prevClose', () => {
  const bars = parseSecurityHistory({ data: [
    { CH_SERIES: 'BE', mTIMESTAMP: '13-Nov-2026', CH_CLOSING_PRICE: 99, CH_PREVIOUS_CLS_PRICE: 95 },
    { CH_SERIES: 'EQ', mTIMESTAMP: '13-Nov-2026', CH_CLOSING_PRICE: 100, CH_PREVIOUS_CLS_PRICE: 96 },
    { CH_SERIES: 'EQ', mTIMESTAMP: '12-Nov-2026', CH_CLOSING_PRICE: 96, CH_PREVIOUS_CLS_PRICE: 94 },
  ] });
  assert.deepEqual(bars, [
    { date: '2026-11-12', close: 96, prevClose: 94 },
    { date: '2026-11-13', close: 100, prevClose: 96 },
  ]);
  assert.deepEqual(chainCloses([{ date: '2026-11-02', close: 110 }, { date: '2026-11-01', close: 100 }]),
    [{ date: '2026-11-02', close: 110, prevClose: 100 }]);
});

// Weekdays from 2026-11-02, closes rising 1% a day
function series(n: number, start = '2026-11-02', step = 0.01): DailyBar[] {
  const out: DailyBar[] = [];
  let d = start; let c = 100;
  while (out.length < n) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) { const prev = c; c = +(c * (1 + step)).toFixed(6); out.push({ date: d, close: c, prevClose: prev }); }
    d = addDays(d, 1);
  }
  return out;
}

test('event after 15:30 uses that day as base; during market uses the day before', () => {
  const bars = series(10);
  assert.equal(bars[baseIndex(bars, '2026-11-04', 18 * 60)].date, '2026-11-04');
  assert.equal(bars[baseIndex(bars, '2026-11-04', 11 * 60)].date, '2026-11-03');
  assert.equal(bars[baseIndex(bars, '2026-11-04', null)].date, '2026-11-03');
  // Saturday filing → Friday's close is the base either way
  assert.equal(bars[baseIndex(bars, '2026-11-07', 10 * 60)].date, '2026-11-06');
  assert.equal(baseIndex(bars, '2026-10-01', null), -1);
});

test('compound uses NSE prevClose, so a split is not a crash', () => {
  // Day 2 is a 1:10 split: close 10.1, NSE adjusted prevClose 10.0
  const bars: DailyBar[] = [
    { date: '2026-11-02', close: 100, prevClose: 99 },
    { date: '2026-11-03', close: 10.1, prevClose: 10 },
    { date: '2026-11-04', close: 10.2, prevClose: 10.1 },
  ];
  assert.ok(Math.abs(compound(bars, 0, 2) - 0.02) < 1e-9);
});

test('computeReaction fills 1/5/20 day returns and NIFTY over the same dates', () => {
  const stock = series(30, '2026-11-02', 0.01);
  const index = series(30, '2026-11-02', 0.002);
  const r = computeReaction(stock, index, '2026-11-02', 18 * 60);
  assert.equal(r.baseDate, '2026-11-02');
  assert.ok(Math.abs(r.ret[1]! - 0.01) < 1e-6);
  assert.ok(Math.abs(r.ret[5]! - (1.01 ** 5 - 1)) < 1e-6);
  assert.ok(Math.abs(r.nifty[5]! - (1.002 ** 5 - 1)) < 1e-6);
  assert.equal(r.complete, true);
  const recent = computeReaction(stock, index, stock[27].date, 18 * 60);
  assert.notEqual(recent.ret[1], null);
  assert.equal(recent.ret[5], null);
  assert.equal(recent.complete, false);
});

test('summarize groups by event type and label, in excess-over-NIFTY percent', () => {
  const row = (label: string, ret5: number, nifty5: number): ReactionRow => ({
    eventType: 'filing', eventId: Math.random(), ticker: 'X', eventDate: '2026-11-01', label, category: '',
    baseDate: '2026-10-31', ret1: null, ret5, ret20: null, nifty1: null, nifty5, nifty20: null, complete: false,
  });
  const [five] = summarize([row('5', 0.10, 0.02), row('5', -0.02, 0.01), row('5', 0.04, 0.0), row('1', 0, 0)])
    .filter(b => b.label === '5');
  assert.equal(five.n, 3);
  assert.ok(Math.abs(five.horizons[5].avgExcess! - (8 - 3 + 4) / 3) < 1e-9);
  assert.ok(Math.abs(five.horizons[5].medianExcess! - 4) < 1e-9);
  assert.ok(Math.abs(five.horizons[5].hitRate! - (200 / 3)) < 1e-9);
  assert.equal(five.horizons[1].n, 0);
});

// ── Board meetings and brief ──────────────────────────────────────────────────

test('parseBoardMeetings flags results meetings', () => {
  const ms = parseBoardMeetings([
    { bm_symbol: 'SUNPHARMA', bm_date: '30-Oct-2026', bm_purpose: 'Board Meeting Intimation', bm_desc: 'to consider and approve the Unaudited Financial results for the quarter ended September 2026' },
    { bm_symbol: 'SUNPHARMA', bm_date: '05-Dec-2026', bm_purpose: 'Fund Raising', bm_desc: 'to consider raising funds' },
  ], 'SUNPHARMA');
  assert.deepEqual(ms.map(m => [m.meetingDate, m.isResults]), [['2026-10-30', true], ['2026-12-05', false]]);
});

test('brief shows last quarter, promises, red flags, watch items and signals, escaped', () => {
  const v = buildQuarterViews([fin('2026-06-30', 110e7, 22e7, 11e7)])[0];
  const html = buildBrief({
    ticker: 'MOREPENLAB', name: 'Morepen Laboratories Ltd.', meetingDate: '2026-11-18', description: '',
    lastQuarter: v, lastCallQuarter: 'Q1FY27',
    lastCallPromises: [promise('Q1FY27', 'Margin', 'EBITDA margin <18% by Q4')],
    olderOpenPromises: [promise('Q3FY26', 'Capex')],
    redFlags: [{ id: 1, ticker: 'MOREPENLAB', quarter: 'Q1FY27', flagType: 'deflected_questions', severity: 'High', evidence: 'We will not comment', detectedAt: '' }],
    watchFor: [{ date: '2026-10-01', watchFor: 'API price trend' }],
    signals: [],
  });
  assert.match(html, /results on 2026-11-18/);
  assert.match(html, /Last quarter<\/b> \(Q1FY27, Consolidated\)/);
  assert.match(html, /EBITDA margin &lt;18% by Q4/);
  assert.match(html, /Older promises still open<\/b> \(1\)/);
  assert.match(html, /🔴 deflected questions/);
  assert.match(html, /API price trend/);
});

test('brief with no history says so instead of sending a header only', () => {
  const html = buildBrief({
    ticker: 'NEW', name: 'New Co', meetingDate: '2026-11-18', description: '', lastQuarter: null, lastCallQuarter: null,
    lastCallPromises: [], olderOpenPromises: [], redFlags: [], watchFor: [], signals: [],
  });
  assert.match(html, /No stored history/);
});
