'use client';

import { useState, useEffect } from 'react';
import AnswerCard from './AnswerCard';
import SentimentChart from './SentimentChart';
import CitationList from './CitationList';
import { useCompanyTickers } from './hooks/useCompanyTickers';
import { useAvailableQuarters } from './hooks/useAvailableQuarters';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const HISTORY_KEY = 'earningslens:query_history';
const MAX_HISTORY = 10;

interface HistoryEntry { query: string; ticker?: string; quarters?: string; ts: number }

export interface Citation { ticker: string; quarter: string; speaker: string; text: string; source: string }
export interface SentimentPoint { quarter: string; label: string; score: number }

interface QueryResult {
  answer: string; citations: Citation[]; sentimentData: SentimentPoint[]; queryLogId?: number;
}
interface SentimentHistory {
  ticker: string; topic: string | null; history: Array<{ quarter: string; sentiment: string; score: number }>;
}

const SPEAKER_ROLES = ['', 'CEO', 'CFO', 'Analyst', 'Other'];

function Sel({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="appearance-none cursor-pointer transition-all duration-150 focus:outline-none"
        style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          color: value ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
          borderRadius: '0.75rem',
          padding: '0.45rem 2rem 0.45rem 0.875rem',
          fontSize: '0.8125rem',
          lineHeight: '1.5',
        }}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs"
        style={{ color: 'rgba(255,255,255,0.3)' }}>▾</span>
    </div>
  );
}

function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { return []; }
}
function saveHistory(entry: HistoryEntry) {
  const prev = loadHistory().filter(h => h.query !== entry.query);
  localStorage.setItem(HISTORY_KEY, JSON.stringify([entry, ...prev].slice(0, MAX_HISTORY)));
}

const dimText = { color: 'rgba(255,255,255,0.45)' };

export default function QueryInterface() {
  const tickers         = useCompanyTickers();
  const allQuarters     = useAvailableQuarters();
  const [query, setQuery]               = useState('');
  const [ticker, setTicker]             = useState('');
  const [quarters, setQuarters]         = useState<string[]>([]);
  const [speakerRole, setSpeakerRole]   = useState('');
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [result, setResult]             = useState<QueryResult | null>(null);
  const [sentimentHistory, setSentimentHistory] = useState<SentimentHistory | null>(null);
  const [history, setHistory]           = useState<HistoryEntry[]>([]);

  useEffect(() => { setHistory(loadHistory()); }, []);

  function toggleQuarter(q: string) {
    setQuarters(prev => prev.includes(q) ? prev.filter(x => x !== q) : [...prev, q]);
  }

  function applyHistory(h: HistoryEntry) {
    setQuery(h.query);
    if (h.ticker) setTicker(h.ticker);
    if (h.quarters) setQuarters(h.quarters.split(',').filter(Boolean));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true); setError(null); setResult(null);

    try {
      const payload: Record<string, unknown> = { query: query.trim() };
      if (ticker) payload.ticker = ticker;
      if (quarters.length > 0) payload.quarters = quarters;
      if (speakerRole) payload.speakerRole = speakerRole;

      const [queryRes, sentimentRes] = await Promise.all([
        fetch(`${API}/api/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
        ticker ? fetch(`${API}/api/sentiment?ticker=${ticker}`) : Promise.resolve(null),
      ]);

      if (!queryRes.ok) { const err = await queryRes.json(); throw new Error(err.error ?? 'Query failed'); }
      const data: QueryResult = await queryRes.json();
      setResult(data);
      const entry: HistoryEntry = { query: query.trim(), ticker: ticker || undefined, quarters: quarters.join(',') || undefined, ts: Date.now() };
      saveHistory(entry); setHistory(loadHistory());
      if (sentimentRes?.ok) { const hist: SentimentHistory = await sentimentRes.json(); setSentimentHistory(hist); }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <form onSubmit={handleSubmit} className="glass rounded-2xl p-5 space-y-4">
        <textarea value={query} onChange={e => setQuery(e.target.value)}
          placeholder="e.g. What did the CFO say about NPA provisioning in Q2 vs Q3 FY26?"
          rows={3}
          className="w-full glass-input rounded-xl px-4 py-3 text-sm resize-none" />

        {/* Quarter pill multi-select */}
        {allQuarters.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {allQuarters.map(q => {
              const on = quarters.includes(q);
              return (
                <button key={q} type="button" onClick={() => toggleQuarter(q)}
                  className="px-3 py-1 text-xs rounded-full transition-all duration-150"
                  style={on
                    ? { background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', color: '#f59e0b' }
                    : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.45)' }
                  }>
                  {q}
                </button>
              );
            })}
            {quarters.length > 0 && (
              <button type="button" onClick={() => setQuarters([])}
                className="px-3 py-1 text-xs rounded-full transition-all duration-150"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.25)' }}>
                clear
              </button>
            )}
          </div>
        )}

        {/* Controls row */}
        <div className="flex flex-wrap gap-3">
          <Sel value={ticker} onChange={setTicker}>
            <option value="" style={{ background: '#0d0f1a' }}>All companies</option>
            {tickers.map(t => <option key={t} value={t} style={{ background: '#0d0f1a' }}>{t}</option>)}
          </Sel>

          <Sel value={speakerRole} onChange={setSpeakerRole}>
            {SPEAKER_ROLES.map(r => (
              <option key={r} value={r} style={{ background: '#0d0f1a' }}>{r || 'All speakers'}</option>
            ))}
          </Sel>

          <button type="submit" disabled={loading || !query.trim()}
            className="ml-auto px-5 py-2 bg-amber-400 text-gray-900 font-semibold text-sm rounded-xl
                       hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed transition-all
                       shadow-[0_0_20px_rgba(245,158,11,0.3)] hover:shadow-[0_0_28px_rgba(245,158,11,0.45)]">
            {loading ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
      </form>

      {history.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider" style={dimText}>Recent queries</p>
          <div className="flex flex-wrap gap-2">
            {history.map((h, i) => (
              <button key={i} onClick={() => applyHistory(h)} title={h.query}
                className="max-w-xs truncate text-left text-xs px-3 py-1.5 rounded-xl glass-sm transition-colors"
                style={{ color: 'rgba(255,255,255,0.5)' }}>
                {h.ticker && <span className="text-amber-400 mr-1">{h.ticker}</span>}
                {h.query.slice(0, 60)}{h.query.length > 60 ? '…' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl px-4 py-3 text-sm text-red-300"
          style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
          {error}
        </div>
      )}

      {result && (
        <>
          <AnswerCard answer={result.answer} queryLogId={result.queryLogId} />
          {sentimentHistory && sentimentHistory.history.length > 0 && (
            <SentimentChart ticker={sentimentHistory.ticker} data={sentimentHistory.history} />
          )}
          {result.sentimentData.length > 0 && (
            <SentimentChart ticker={ticker || 'Query'} data={result.sentimentData.map(s => ({ quarter: s.quarter, sentiment: s.label, score: s.score }))} title="Sentiment — retrieved chunks" />
          )}
          <CitationList citations={result.citations} />
        </>
      )}
    </div>
  );
}
