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

const LABELS: Record<string, string> = { filing: 'Filing importance', red_flag: 'Red flag severity', signal: 'Signal' };

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

export default function Scorecard() {
  const tickers = useCompanyTickers();
  const [ticker, setTicker] = useState('');
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [events, setEvents] = useState(0);
  const [quarters, setQuarters] = useState<QuarterView[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
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
            <h3 className="text-sm font-semibold text-white mb-2">Quarterly results — {ticker}</h3>
            <FinancialsTable quarters={quarters} />
          </section>
          <section className="glass rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-2">Insider, pledge and deal activity — {ticker}</h3>
            <SignalsList signals={signals} />
          </section>
        </>
      )}
    </div>
  );
}
