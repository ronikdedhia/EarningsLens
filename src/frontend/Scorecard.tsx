'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/frontend/api';
import { useCompanyTickers } from './hooks/useCompanyTickers';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface HorizonStats { n: number; avgReturn: number | null; avgExcess: number | null; medianExcess: number | null; hitRate: number | null }
interface Bucket { eventType: string; label: string; n: number; horizons: Record<string, HorizonStats> }

interface FinancialRow {
  quarter: string; periodEnd: string; basis: string; revenue: number | null; ebitda: number | null;
  pat: number | null; eps: number | null; filedAt: string;
}
interface Changes { revenuePct: number | null; ebitdaPct: number | null; patPct: number | null; ebitdaMarginBps: number | null }
interface Promise_ { quarterPromised: string; verbatimQuote: string; timeframe: string; status: string; category: string }
interface QuarterView {
  row: FinancialRow; ebitdaMargin: number | null; patMargin: number | null;
  qoq: Changes | null; yoy: Changes | null; promises: Promise_[];
}
interface Signal {
  id: number; signalType: string; eventDate: string; party: string; category: string;
  direction: string; quantity: number | null; value: number | null; price: number | null; detail: string;
}
interface Meeting { ticker: string; meetingDate: string; purpose: string; briefSentAt: string | null }

const LABELS: Record<string, string> = { filing: 'Filing importance', red_flag: 'Red flag severity', signal: 'Signal', fda: 'US FDA' };

const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const cr = (v: number | null) => (v == null ? '—' : (v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 1 }));
const tone = (v: number | null | undefined) => (v == null ? 'text-slate-500' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-300');

function ReactionTable({ buckets }: { buckets: Bucket[] }) {
  if (!buckets.length) {
    return <p className="text-xs text-slate-400">No measured events yet. Reactions fill in as filings and signals age 1, 5 and 20 sessions.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-400">
          <tr className="border-b border-slate-700">
            <th className="text-left py-2 pr-3">Event</th>
            <th className="text-right px-2">N</th>
            {[1, 5, 20].map(h => <th key={h} className="text-right px-2" colSpan={2}>{h}d vs NIFTY · beat %</th>)}
          </tr>
        </thead>
        <tbody>
          {buckets.map(b => (
            <tr key={`${b.eventType}|${b.label}`} className="border-b border-slate-800">
              <td className="py-1.5 pr-3 text-slate-200">{LABELS[b.eventType] ?? b.eventType}: <b>{b.label}</b></td>
              <td className="text-right px-2 text-slate-400">{b.n}</td>
              {[1, 5, 20].map(h => {
                const s = b.horizons[h];
                return [
                  <td key={`${h}e`} className={`text-right px-2 ${tone(s?.avgExcess)}`} title={`n=${s?.n ?? 0}, median ${pct(s?.medianExcess)}`}>{pct(s?.avgExcess)}</td>,
                  <td key={`${h}h`} className="text-right px-2 text-slate-400">{s?.hitRate == null ? '—' : `${s.hitRate.toFixed(0)}%`}</td>,
                ];
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-500 mt-2">
        Average move of the stock minus NIFTY 50 over 1, 5 and 20 sessions after the event; “beat %” is how often the stock beat the index.
        Small N means noise: treat anything under ~20 events as anecdotal.
      </p>
    </div>
  );
}

function FinancialsTable({ quarters }: { quarters: QuarterView[] }) {
  const consolidated = new Set(quarters.filter(q => q.row.basis === 'Consolidated').map(q => q.row.periodEnd));
  const rows = quarters.filter(q => q.row.basis === 'Consolidated' || !consolidated.has(q.row.periodEnd)).reverse();
  if (!rows.length) return <p className="text-xs text-slate-400">No results filings stored for this company yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-400">
          <tr className="border-b border-slate-700">
            <th className="text-left py-2 pr-2">Quarter</th>
            <th className="text-right px-2">Revenue ₹Cr</th><th className="text-right px-2">YoY</th><th className="text-right px-2">QoQ</th>
            <th className="text-right px-2">EBITDA ₹Cr</th><th className="text-right px-2">Margin</th><th className="text-right px-2">Δ YoY</th>
            <th className="text-right px-2">PAT ₹Cr</th><th className="text-right px-2">YoY</th><th className="text-right px-2">EPS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(q => (
            <tr key={`${q.row.periodEnd}|${q.row.basis}`} className="border-b border-slate-800 align-top">
              <td className="py-1.5 pr-2 text-slate-200">
                {q.row.quarter}<span className="text-slate-500"> · {q.row.basis === 'Consolidated' ? 'C' : 'S'}</span>
                {q.promises.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-[11px] text-amber-400 cursor-pointer">{q.promises.length} guidance</summary>
                    <ul className="mt-1 space-y-1">
                      {q.promises.map((p, i) => (
                        <li key={i} className="text-[11px] text-slate-300 max-w-xs">
                          “{p.verbatimQuote}” <span className="text-slate-500">({p.quarterPromised}, {p.status})</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </td>
              <td className="text-right px-2 text-slate-200">{cr(q.row.revenue)}</td>
              <td className={`text-right px-2 ${tone(q.yoy?.revenuePct)}`}>{pct(q.yoy?.revenuePct)}</td>
              <td className={`text-right px-2 ${tone(q.qoq?.revenuePct)}`}>{pct(q.qoq?.revenuePct)}</td>
              <td className="text-right px-2 text-slate-200">{cr(q.row.ebitda)}</td>
              <td className="text-right px-2 text-slate-300">{q.ebitdaMargin == null ? '—' : `${q.ebitdaMargin.toFixed(1)}%`}</td>
              <td className={`text-right px-2 ${tone(q.yoy?.ebitdaMarginBps)}`}>{q.yoy?.ebitdaMarginBps == null ? '—' : `${q.yoy.ebitdaMarginBps >= 0 ? '+' : ''}${q.yoy.ebitdaMarginBps.toFixed(0)} bp`}</td>
              <td className="text-right px-2 text-slate-200">{cr(q.row.pat)}</td>
              <td className={`text-right px-2 ${tone(q.yoy?.patPct)}`}>{pct(q.yoy?.patPct)}</td>
              <td className="text-right px-2 text-slate-300">{q.row.eps?.toFixed(2) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-500 mt-2">From the results XBRL each company files with NSE. EBITDA = PBT − exceptional items + finance costs + depreciation − other income.</p>
    </div>
  );
}

function SignalsList({ signals }: { signals: Signal[] }) {
  if (!signals.length) return <p className="text-xs text-slate-400">No insider trades, SAST filings, pledge changes or bulk/block deals in the last 365 days.</p>;
  const label: Record<string, string> = { insider: 'Insider', sast: 'SAST', pledge: 'Pledge', bulk_deal: 'Bulk deal', block_deal: 'Block deal' };
  return (
    <ul className="space-y-1.5 text-xs">
      {signals.map(s => (
        <li key={s.id} className="flex gap-3 border-b border-slate-800 pb-1.5">
          <span className="text-slate-500 w-20 shrink-0">{s.eventDate}</span>
          <span className="text-slate-400 w-20 shrink-0">{label[s.signalType] ?? s.signalType}</span>
          <span className={s.direction.includes('sell') || s.direction === 'pledge' || s.direction === 'increase' ? 'text-rose-300' : 'text-slate-200'}>
            {s.signalType === 'pledge'
              ? s.detail
              : `${s.direction.replace('_', ' ')} ${s.value != null ? `₹${cr(s.value)} Cr` : s.quantity != null ? `${s.quantity.toLocaleString('en-IN')} sh` : ''}${s.price ? ` @ ₹${s.price.toFixed(2)}` : ''} — ${s.party}${s.category ? ` (${s.category})` : ''}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface RangeT { current: number | null; min: number | null; median: number | null; max: number | null; percentile: number | null }
interface ValuationT { asOf: string | null; price: number | null; marketCap: number | null; netDebt: number | null; pe: RangeT; evEbitda: RangeT; days: number }
interface Holding { periodEnd: string; promoter: number | null; fii: number | null; dii: number | null; mf: number | null; shareholders: number | null; flags: { alerts: string[] } }
interface Order { announcedDate: string; valueInr: number | null; client: string; description: string; sourceUrl: string }
interface OrderSummaryT { last12mInr: number; last12mCount: number; unvalued: number; coverage: number | null; ttmRevenue: number | null }
interface FdaEventT { id: number; eventDate: string; label: string; bad: boolean; title: string; url: string; source: string }

function RangeBar({ label, r }: { label: string; r: RangeT }) {
  if (r.current == null) return <div className="text-xs text-slate-500">{label}: n/a</div>;
  const pos = r.min != null && r.max != null && r.max > r.min ? ((r.current - r.min) / (r.max - r.min)) * 100 : 50;
  return (
    <div className="text-xs space-y-1">
      <div className="flex justify-between text-slate-300">
        <span>{label} <b className="text-white">{r.current.toFixed(1)}×</b></span>
        <span className="text-slate-500">2y {r.min?.toFixed(1)}–{r.max?.toFixed(1)} · median {r.median?.toFixed(1)} · {r.percentile?.toFixed(0)}% of days were cheaper</span>
      </div>
      <div className="relative h-1.5 rounded bg-slate-700">
        <div className="absolute top-[-3px] h-3 w-1 rounded bg-amber-400" style={{ left: `calc(${Math.min(100, Math.max(0, pos))}% - 2px)` }} />
      </div>
    </div>
  );
}

function ValuationCard({ v }: { v: ValuationT | null }) {
  if (!v || v.marketCap == null) return <p className="text-xs text-slate-400">Not enough data yet (needs shares outstanding and four quarters of results).</p>;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-300">
        Market cap <b className="text-white">₹{cr(v.marketCap)} Cr</b> at ₹{v.price?.toFixed(2)} ({v.asOf})
        {v.netDebt != null && <> · net {v.netDebt >= 0 ? 'debt' : 'cash'} ₹{cr(Math.abs(v.netDebt))} Cr</>}
      </p>
      <RangeBar label="P/E" r={v.pe} />
      <RangeBar label="EV/EBITDA" r={v.evEbitda} />
      {v.days < 250 && <p className="text-[11px] text-slate-500">Range covers {v.days} trading days only.</p>}
    </div>
  );
}

function HoldingsTable({ rows }: { rows: Holding[] }) {
  if (!rows.length) return <p className="text-xs text-slate-400">No shareholding filings stored yet.</p>;
  const d = (a: number | null, b: number | null) => (a == null || b == null ? null : a - b);
  const list = [...rows].reverse();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-400"><tr className="border-b border-slate-700">
          <th className="text-left py-2">Quarter</th>
          {['Promoter', 'FII', 'DII', 'MF'].map(h => <th key={h} className="text-right px-2">{h}</th>)}
          <th className="text-right px-2">Shareholders</th>
        </tr></thead>
        <tbody>
          {list.map((r, i) => {
            const prev = list[i + 1];
            const cell = (k: 'promoter' | 'fii' | 'dii' | 'mf') => {
              const delta = prev ? d(r[k], prev[k]) : null;
              return <td key={k} className="text-right px-2 text-slate-200">{r[k]?.toFixed(2) ?? '—'}%
                {delta != null && Math.abs(delta) >= 0.01 && <span className={`ml-1 ${tone(delta)}`}>{delta > 0 ? '+' : ''}{delta.toFixed(2)}</span>}</td>;
            };
            return (
              <tr key={r.periodEnd} className="border-b border-slate-800 align-top">
                <td className="py-1.5 text-slate-200">{r.periodEnd}
                  {r.flags.alerts.length > 0 && <ul className="mt-1">{r.flags.alerts.map((a, j) => <li key={j} className="text-[11px] text-amber-400">⚠ {a}</li>)}</ul>}
                </td>
                {cell('promoter')}{cell('fii')}{cell('dii')}{cell('mf')}
                <td className="text-right px-2 text-slate-300">{r.shareholders?.toLocaleString('en-IN') ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OrdersList({ orders, s }: { orders: Order[]; s: OrderSummaryT | null }) {
  if (!orders.length) return <p className="text-xs text-slate-400">No order-win announcements found.</p>;
  return (
    <div className="space-y-2 text-xs">
      {s && <p className="text-slate-300">Last 12 months: <b className="text-white">{s.last12mCount}</b> orders, <b className="text-white">₹{cr(s.last12mInr)} Cr</b>
        {s.coverage != null && <> = <b className="text-amber-400">{s.coverage.toFixed(2)}×</b> TTM revenue (₹{cr(s.ttmRevenue)} Cr)</>}
        {s.unvalued > 0 && <span className="text-slate-500"> · {s.unvalued} without a stated value</span>}</p>}
      <ul className="space-y-1">
        {orders.slice(0, 20).map(o => (
          <li key={o.sourceUrl} className="flex gap-3 border-b border-slate-800 pb-1">
            <span className="text-slate-500 w-20 shrink-0">{o.announcedDate}</span>
            <span className="text-slate-200 w-24 shrink-0 text-right">{o.valueInr != null ? `₹${cr(o.valueInr)} Cr` : '—'}</span>
            <a href={o.sourceUrl} target="_blank" rel="noreferrer" className="text-slate-300 hover:text-white">{o.client || o.description.slice(0, 90)}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FdaList({ events }: { events: FdaEventT[] }) {
  if (!events.length) return <p className="text-xs text-slate-400">No US FDA events in the last 2 years.</p>;
  return (
    <ul className="space-y-1 text-xs">
      {events.slice(0, 30).map(e => (
        <li key={e.id} className="flex gap-3 border-b border-slate-800 pb-1">
          <span className="text-slate-500 w-20 shrink-0">{e.eventDate}</span>
          <span className={`w-44 shrink-0 ${e.bad ? 'text-rose-400' : 'text-emerald-400'}`}>{e.label}</span>
          <a href={e.url} target="_blank" rel="noreferrer" className="text-slate-300 hover:text-white">{e.title}</a>
        </li>
      ))}
    </ul>
  );
}

const PHARMA = new Set(['WOCKPHARMA', 'MOREPENLAB', 'RUBICON', 'SUNPHARMA']);

export default function Scorecard() {
  const tickers = useCompanyTickers();
  const [ticker, setTicker] = useState('');
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [events, setEvents] = useState(0);
  const [quarters, setQuarters] = useState<QuarterView[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [valuation, setValuation] = useState<ValuationT | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [orderSum, setOrderSum] = useState<OrderSummaryT | null>(null);
  const [fda, setFda] = useState<FdaEventT[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch(`${API}/api/market/calendar`).then(r => r.json()).then(d => setMeetings(d.meetings ?? [])).catch(() => {});
  }, []);

  // Pick the first company once; choosing "All companies" afterwards must stick.
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (!picked && tickers.length) { setTicker(tickers[0]); setPicked(true); }
  }, [tickers, picked]);

  const load = useCallback(async () => {
    setError('');
    try {
      const q = ticker ? `?ticker=${encodeURIComponent(ticker)}` : '';
      const [s, f, g] = await Promise.all([
        apiFetch(`${API}/api/market/reactions/summary${q}`).then(r => r.json()),
        ticker ? apiFetch(`${API}/api/market/financials${q}`).then(r => r.json()) : Promise.resolve({ quarters: [] }),
        ticker ? apiFetch(`${API}/api/market/signals${q}&days=365`).then(r => r.json()) : Promise.resolve({ signals: [] }),
      ]);
      setBuckets(s.buckets ?? []);
      setEvents(s.events ?? 0);
      setQuarters(f.quarters ?? []);
      setSignals(g.signals ?? []);
      if (ticker) {
        const j = (p: string) => apiFetch(`${API}/api/market/${p}${q}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
        const [v, h, o, d] = await Promise.all([j('valuation'), j('shareholding'), j('orders'),
          PHARMA.has(ticker) ? apiFetch(`${API}/api/market/fda${q}&days=730`).then(r => r.json()).catch(() => null) : Promise.resolve(null)]);
        setValuation(v);
        setHoldings(h?.quarters ?? []);
        setOrders(o?.orders ?? []);
        setOrderSum(o?.summary ?? null);
        setFda(d?.events ?? []);
      }
    } catch {
      setError('Could not load scorecard data.');
    }
  }, [ticker]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Scorecard</h2>
          <p className="text-xs text-slate-400 mt-0.5">Reported numbers, insider and deal activity, and how the stock moved after each kind of event</p>
        </div>
        <select
          value={ticker}
          onChange={e => setTicker(e.target.value)}
          className="text-xs bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-slate-200"
        >
          <option value="">All companies (reactions only)</option>
          {tickers.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {meetings.length > 0 && (
        <section className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-2">Upcoming results</h3>
          <div className="flex flex-wrap gap-2 text-xs">
            {meetings.map(m => (
              <span key={`${m.ticker}${m.meetingDate}`} className="px-2 py-1 rounded bg-slate-800 text-slate-200">
                {m.ticker} · {m.meetingDate}{m.briefSentAt ? ' · brief sent' : ''}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="glass rounded-xl p-4">
        <h3 className="text-sm font-semibold text-white mb-2">Price reaction by event type <span className="text-slate-500 font-normal">({events} events{ticker ? `, ${ticker}` : ''})</span></h3>
        <ReactionTable buckets={buckets} />
      </section>

      {ticker && (
        <>
          <section className="glass rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-2">Valuation — {ticker}</h3>
            <ValuationCard v={valuation} />
          </section>
          <section className="glass rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-2">Quarterly results — {ticker}</h3>
            <FinancialsTable quarters={quarters} />
          </section>
          <section className="glass rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-2">Shareholding — {ticker}</h3>
            <HoldingsTable rows={holdings} />
          </section>
          <section className="glass rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-2">Order wins — {ticker}</h3>
            <OrdersList orders={orders} s={orderSum} />
          </section>
          {PHARMA.has(ticker) && (
            <section className="glass rounded-xl p-4">
              <h3 className="text-sm font-semibold text-white mb-2">US FDA — {ticker}</h3>
              <FdaList events={fda} />
            </section>
          )}
          <section className="glass rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-2">Insider, pledge and deal activity — {ticker}</h3>
            <SignalsList signals={signals} />
          </section>
        </>
      )}
    </div>
  );
}
