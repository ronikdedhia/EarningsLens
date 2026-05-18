'use client';

import { useState, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useCompanyTickers } from './hooks/useCompanyTickers';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const PRESET_KEYWORDS = [
  'NIM', 'NPA', 'credit growth', 'slippages', 'CASA', 'cost of funds',
  'asset quality', 'deal wins', 'attrition', 'margins', 'guidance',
  'digital', 'capex', 'revenue growth', 'headcount',
];

interface Sample { ticker: string; quarter: string; speaker: string; text: string; score: number }
interface DataPoint { ticker: string; quarter: string; count: number; samples: Sample[] }

const dim = { color: 'rgba(255,255,255,0.35)' };
const dimmer = { color: 'rgba(255,255,255,0.22)' };

export default function KeywordTracker() {
  const tickers = useCompanyTickers();
  const [input, setInput]           = useState('');
  const [ticker, setTicker]         = useState('');
  const [data, setData]             = useState<DataPoint[]>([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [selected, setSelected]     = useState<DataPoint | null>(null);
  const [queried, setQueried]       = useState('');
  const [queriedTicker, setQueriedTicker] = useState('');
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const tickerTimer = useRef<ReturnType<typeof setTimeout>>();

  async function track(keyword: string, tickerVal?: string) {
    const q = keyword.trim();
    if (!q) return;
    const t = (tickerVal ?? ticker).trim().toUpperCase();
    setLoading(true); setError(null); setSelected(null); setQueried(q); setQueriedTicker(t);
    try {
      const params = new URLSearchParams({ q, topK: '50' });
      if (t) params.set('ticker', t);
      const res = await fetch(`${API}/api/queries/keyword?${params}`);
      if (!res.ok) throw new Error('Search failed');
      const json = await res.json();
      setData(json.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  function handleTickerChange(val: string) {
    setTicker(val);
    if (queried) {
      clearTimeout(tickerTimer.current);
      tickerTimer.current = setTimeout(() => track(queried, val), 350);
    }
  }

  function handlePreset(kw: string) { setActivePreset(kw); setInput(''); track(kw); }
  function handleSearch() { if (!input.trim()) return; setActivePreset(null); track(input.trim()); }

  const maxCount = Math.max(...data.map(d => d.count), 1);

  return (
    <div className="space-y-5">
      <div className="glass rounded-2xl p-5 space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">Keyword Frequency Tracker</p>
          <p className="text-xs mt-1" style={dimmer}>Semantic search — tracks how often a topic surfaces across quarters</p>
        </div>

        {/* Preset chips */}
        <div className="flex flex-wrap gap-2">
          {PRESET_KEYWORDS.map(kw => {
            const on = activePreset === kw;
            return (
              <button key={kw} onClick={() => handlePreset(kw)} disabled={loading}
                className="px-3 py-1 text-xs rounded-full transition-all duration-200 disabled:opacity-40"
                style={on
                  ? { background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.35)', color: '#f59e0b' }
                  : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.45)' }
                }>
                {kw}
              </button>
            );
          })}
        </div>

        {/* Custom search + ticker filter */}
        <div className="flex flex-wrap gap-3">
          <input value={input} onChange={e => { setInput(e.target.value); setActivePreset(null); }}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Custom phrase…"
            className="flex-1 min-w-44 glass-input rounded-xl px-3 py-2 text-sm" />
          <div className="relative">
            <select
              value={ticker}
              onChange={e => handleTickerChange(e.target.value)}
              className="appearance-none cursor-pointer transition-all duration-150 focus:outline-none"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: ticker ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
                borderRadius: '0.75rem',
                padding: '0.45rem 2rem 0.45rem 0.875rem',
                fontSize: '0.8125rem',
                lineHeight: '1.5',
              }}
            >
              <option value="" style={{ background: '#0d0f1a' }}>All companies</option>
              {tickers.map(t => <option key={t} value={t} style={{ background: '#0d0f1a' }}>{t}</option>)}
            </select>
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs"
              style={{ color: 'rgba(255,255,255,0.3)' }}>▾</span>
          </div>
          <button onClick={handleSearch} disabled={loading || !input.trim()}
            className="px-5 py-2 bg-amber-400 text-gray-900 font-semibold text-sm rounded-xl
                       hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed transition-all
                       shadow-[0_0_20px_rgba(245,158,11,0.3)]">
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl px-4 py-3 text-sm text-red-300"
          style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
          {error}
        </div>
      )}

      {loading && <div className="text-center py-8 text-sm" style={dimmer}>Searching…</div>}

      {!loading && data.length > 0 && (
        <div className="glass rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">
              &ldquo;{queried}&rdquo;{queriedTicker && <> · <span className="font-mono">{queriedTicker}</span></>} — mentions by quarter
            </p>
            <span className="text-xs" style={dimmer}>{data.reduce((s, d) => s + d.count, 0)} total</span>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 4, right: 16, left: -20, bottom: 4 }}
              onClick={e => { if (e?.activePayload?.[0]) setSelected(e.activePayload[0].payload as DataPoint); }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="quarter" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
                axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
                axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: 'rgba(8,10,22,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12 }}
                labelStyle={{ color: '#f59e0b', fontWeight: 600, fontSize: 12 }}
                itemStyle={{ color: 'rgba(255,255,255,0.8)', fontSize: 12 }}
                formatter={(v: number) => [v, 'mentions']} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]} cursor="pointer">
                {data.map((d, i) => (
                  <Cell key={i} fill={
                    selected?.quarter === d.quarter && selected?.ticker === d.ticker
                      ? '#f59e0b'
                      : `hsl(${210 + (d.count / maxCount) * 35}, 65%, ${32 + (d.count / maxCount) * 22}%)`
                  } />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-center" style={dimmer}>Click a bar to see source snippets</p>
        </div>
      )}

      {!loading && data.length === 0 && queried && (
        <div className="text-center py-12 text-sm" style={dimmer}>No matches for &ldquo;{queried}&rdquo;.</div>
      )}

      {selected && (
        <div className="glass rounded-2xl p-5 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">
            {selected.ticker} {selected.quarter} — {selected.count} mention{selected.count !== 1 ? 's' : ''}
          </p>
          {selected.samples.map((s, i) => (
            <div key={i} className="pl-4 space-y-1" style={{ borderLeft: '2px solid rgba(245,158,11,0.2)' }}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-amber-400">{s.ticker}</span>
                <span className="text-xs" style={dim}>{s.quarter}</span>
                <span className="text-xs" style={dimmer}>·</span>
                <span className="text-xs" style={dim}>{s.speaker}</span>
                <span className="text-xs ml-auto" style={dimmer}>score {s.score.toFixed(3)}</span>
              </div>
              <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.72)' }}>
                &ldquo;{s.text}&rdquo;
              </p>
            </div>
          ))}
          {selected.count > selected.samples.length && (
            <p className="text-xs" style={dimmer}>+{selected.count - selected.samples.length} more chunks</p>
          )}
        </div>
      )}
    </div>
  );
}
