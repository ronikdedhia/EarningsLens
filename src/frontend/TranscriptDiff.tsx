'use client';

import { useState, useEffect } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface KeywordDelta {
  word: string;
  q1Count: number;
  q2Count: number;
  delta: number;
  pctChange: number | null;
}

interface PhraseChange { before: string; after: string }

interface DiffResult {
  q1: string;
  q2: string;
  ticker: string;
  keywordDeltas: KeywordDelta[];
  toneScoreDelta: number | null;
  q1ToneScore: number | null;
  q2ToneScore: number | null;
  semantic: {
    droppedTopics: string[];
    newTopics: string[];
    phraseChanges: PhraseChange[];
    toneShift: string;
    summary: string;
  };
}

function DeltaBadge({ delta, pct }: { delta: number; pct: number | null }) {
  const up = delta > 0;
  const color = delta === 0 ? 'rgba(255,255,255,0.3)' : up ? '#34d399' : '#f87171';
  return (
    <div className="flex flex-col items-end">
      <span className="text-sm font-semibold tabular-nums" style={{ color }}>
        {up ? '+' : ''}{delta}
      </span>
      {pct !== null && (
        <span className="text-[10px] tabular-nums" style={{ color: `${color}80` }}>
          {up ? '+' : ''}{pct}%
        </span>
      )}
    </div>
  );
}

function FreqBar({ q1, q2 }: { q1: number; q2: number }) {
  const max = Math.max(q1, q2, 1);
  return (
    <div className="flex items-center gap-1 w-24">
      <div className="flex-1 flex flex-col gap-0.5">
        <div
          className="rounded-sm h-1.5"
          style={{ width: `${Math.round((q1 / max) * 100)}%`, background: 'rgba(148,163,184,0.4)', minWidth: q1 > 0 ? 2 : 0 }}
        />
        <div
          className="rounded-sm h-1.5"
          style={{
            width: `${Math.round((q2 / max) * 100)}%`,
            background: q2 > q1 ? '#34d399' : q2 < q1 ? '#f87171' : 'rgba(148,163,184,0.4)',
            minWidth: q2 > 0 ? 2 : 0,
          }}
        />
      </div>
    </div>
  );
}

export default function TranscriptDiff() {
  const [inputTicker, setInputTicker] = useState('');
  const [ticker, setTicker]           = useState('');
  const [quarters, setQuarters]       = useState<string[]>([]);
  const [q1, setQ1]                   = useState('');
  const [q2, setQ2]                   = useState('');
  const [result, setResult]           = useState<DiffResult | null>(null);
  const [loading, setLoading]         = useState(false);
  const [quartersLoading, setQLoading] = useState(false);
  const [error, setError]             = useState('');
  const [showTop, setShowTop]         = useState<'increased' | 'dropped' | 'all'>('all');

  const loadQuarters = async (t: string) => {
    setQLoading(true);
    setQuarters([]);
    setQ1('');
    setQ2('');
    setResult(null);
    try {
      const res  = await fetch(`${API}/api/diff/quarters?ticker=${encodeURIComponent(t)}`);
      const data = await res.json();
      const qs: string[] = data.quarters ?? [];
      setQuarters(qs);
      if (qs.length >= 2) {
        setQ1(qs[qs.length - 2]);
        setQ2(qs[qs.length - 1]);
      }
    } catch {
      setError('Could not load quarters.');
    } finally {
      setQLoading(false);
    }
  };

  const handleSearch = () => {
    const t = inputTicker.trim().toUpperCase();
    if (!t) return;
    setTicker(t);
    setError('');
    loadQuarters(t);
  };

  const runDiff = async () => {
    if (!ticker || !q1 || !q2 || q1 === q2) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch(
        `${API}/api/diff?ticker=${encodeURIComponent(ticker)}&q1=${encodeURIComponent(q1)}&q2=${encodeURIComponent(q2)}`
      );
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? 'Diff failed.');
        return;
      }
      const data = await res.json();
      setResult(data);
    } catch {
      setError('Diff request failed.');
    } finally {
      setLoading(false);
    }
  };

  const filteredDeltas = result
    ? result.keywordDeltas.filter(d => {
        if (showTop === 'increased') return d.delta > 0;
        if (showTop === 'dropped')   return d.delta < 0;
        return true;
      })
    : [];

  const scoreColor = (d: number | null) =>
    d === null ? 'rgba(255,255,255,0.4)' : d > 0 ? '#34d399' : d < 0 ? '#f87171' : 'rgba(255,255,255,0.5)';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h1
          className="text-3xl font-normal"
          style={{ fontFamily: 'var(--font-display), Georgia, serif', color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.02em' }}
        >
          Quarter Diff
        </h1>
        <p className="text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>
          Compare two earnings quarters — what management started talking about, what disappeared, and how the tone shifted.
        </p>
      </div>

      {/* Search */}
      <div className="flex gap-2 flex-wrap">
        <input
          className="glass-input flex-1 rounded-xl px-4 py-2.5 text-sm font-mono uppercase"
          placeholder="Ticker (e.g. HDFCBANK)"
          value={inputTicker}
          onChange={e => setInputTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
        />
        <button
          onClick={handleSearch}
          disabled={!inputTicker.trim()}
          className="px-5 py-2.5 text-sm font-semibold rounded-xl transition-all disabled:opacity-40"
          style={{ background: 'rgba(245,158,11,0.9)', color: '#111' }}
        >
          Load
        </button>
      </div>

      {/* Quarter selectors */}
      {ticker && (
        <div className="flex items-center gap-3 flex-wrap">
          {quartersLoading ? (
            <span className="text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>Loading quarters…</span>
          ) : quarters.length < 2 ? (
            <span className="text-sm" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {quarters.length === 0 ? 'No ingested quarters found.' : 'Need at least 2 quarters to diff.'}
            </span>
          ) : (
            <>
              <select
                className="glass-input text-sm rounded-xl px-3 py-2"
                value={q1}
                onChange={e => setQ1(e.target.value)}
              >
                {quarters.map(q => <option key={q} value={q}>{q}</option>)}
              </select>
              <span style={{ color: 'rgba(255,255,255,0.3)' }}>→</span>
              <select
                className="glass-input text-sm rounded-xl px-3 py-2"
                value={q2}
                onChange={e => setQ2(e.target.value)}
              >
                {quarters.map(q => <option key={q} value={q}>{q}</option>)}
              </select>
              <button
                onClick={runDiff}
                disabled={!q1 || !q2 || q1 === q2 || loading}
                className="px-5 py-2 text-sm font-semibold rounded-xl transition-all disabled:opacity-40"
                style={{ background: 'rgba(245,158,11,0.9)', color: '#111' }}
              >
                {loading ? 'Analysing…' : 'Compare'}
              </button>
            </>
          )}
        </div>
      )}

      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}

      {loading && (
        <div className="text-sm py-12 text-center" style={{ color: 'rgba(255,255,255,0.3)' }}>
          <span className="animate-spin inline-block mr-2">⟳</span>
          Running AI diff — this may take 10–20 seconds…
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-5">
          {/* Tone score banner */}
          <div
            className="rounded-2xl px-5 py-4 flex items-center gap-6 flex-wrap"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <div className="text-center">
              <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
                {result.q1}
              </div>
              <div className="text-2xl font-bold tabular-nums" style={{ color: 'rgba(255,255,255,0.8)' }}>
                {result.q1ToneScore ?? '—'}
              </div>
            </div>
            <div className="text-center">
              <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
                Tone shift
              </div>
              <div className="text-2xl font-bold tabular-nums" style={{ color: scoreColor(result.toneScoreDelta) }}>
                {result.toneScoreDelta !== null
                  ? `${result.toneScoreDelta > 0 ? '+' : ''}${result.toneScoreDelta}`
                  : '—'}
              </div>
            </div>
            <div className="text-center">
              <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
                {result.q2}
              </div>
              <div className="text-2xl font-bold tabular-nums" style={{ color: 'rgba(255,255,255,0.8)' }}>
                {result.q2ToneScore ?? '—'}
              </div>
            </div>
            {result.semantic.toneShift && (
              <p className="flex-1 text-sm" style={{ color: 'rgba(255,255,255,0.5)', fontStyle: 'italic' }}>
                {result.semantic.toneShift}
              </p>
            )}
          </div>

          {/* Topics: dropped + new */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div
              className="rounded-2xl p-4 space-y-2"
              style={{ background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.15)' }}
            >
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'rgba(248,113,113,0.7)' }}>
                Dropped topics ({result.q1} → gone in {result.q2})
              </p>
              {result.semantic.droppedTopics.length === 0
                ? <p className="text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>None detected</p>
                : result.semantic.droppedTopics.map((t, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span style={{ color: '#f87171', fontSize: 10 }}>▼</span>
                      <span className="text-sm" style={{ color: 'rgba(255,255,255,0.75)' }}>{t}</span>
                    </div>
                  ))
              }
            </div>

            <div
              className="rounded-2xl p-4 space-y-2"
              style={{ background: 'rgba(52,211,153,0.05)', border: '1px solid rgba(52,211,153,0.15)' }}
            >
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'rgba(52,211,153,0.7)' }}>
                New topics (appeared in {result.q2})
              </p>
              {result.semantic.newTopics.length === 0
                ? <p className="text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>None detected</p>
                : result.semantic.newTopics.map((t, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span style={{ color: '#34d399', fontSize: 10 }}>▲</span>
                      <span className="text-sm" style={{ color: 'rgba(255,255,255,0.75)' }}>{t}</span>
                    </div>
                  ))
              }
            </div>
          </div>

          {/* Phrase shifts */}
          {result.semantic.phraseChanges.length > 0 && (
            <div
              className="rounded-2xl p-4 space-y-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.35)' }}>
                Phrase shifts
              </p>
              {result.semantic.phraseChanges.map((pc, i) => (
                <div key={i} className="flex items-center gap-3 flex-wrap text-sm">
                  <span
                    className="px-2 py-0.5 rounded"
                    style={{ background: 'rgba(248,113,113,0.1)', color: 'rgba(248,113,113,0.85)', fontStyle: 'italic' }}
                  >
                    "{pc.before}"
                  </span>
                  <span style={{ color: 'rgba(255,255,255,0.3)' }}>→</span>
                  <span
                    className="px-2 py-0.5 rounded"
                    style={{ background: 'rgba(52,211,153,0.1)', color: 'rgba(52,211,153,0.85)', fontStyle: 'italic' }}
                  >
                    "{pc.after}"
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* AI Summary */}
          {result.semantic.summary && (
            <div
              className="rounded-2xl p-4"
              style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.12)' }}
            >
              <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'rgba(245,158,11,0.6)' }}>
                AI Diff Summary
              </p>
              <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.75)' }}>
                {result.semantic.summary}
              </p>
            </div>
          )}

          {/* Keyword frequency delta table */}
          <div
            className="rounded-2xl overflow-hidden"
            style={{ border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <div
              className="px-4 py-3 flex items-center justify-between"
              style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}
            >
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.35)' }}>
                Keyword frequency delta
              </p>
              <div className="flex gap-1">
                {(['all', 'increased', 'dropped'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setShowTop(f)}
                    className="px-3 py-1 text-[11px] font-medium rounded-lg transition-all capitalize"
                    style={{
                      background: showTop === f ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.04)',
                      color:      showTop === f ? '#f59e0b'               : 'rgba(255,255,255,0.4)',
                      border:     showTop === f ? '1px solid rgba(245,158,11,0.2)' : '1px solid transparent',
                    }}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div
                className="grid px-4 py-2 text-[10px] uppercase tracking-widest"
                style={{ gridTemplateColumns: '1fr 3rem 3rem 5rem 5rem', color: 'rgba(255,255,255,0.3)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}
              >
                <span>Word</span>
                <span className="text-right">{result.q1}</span>
                <span className="text-right">{result.q2}</span>
                <span className="text-right pr-2">Trend</span>
                <span className="text-right">Change</span>
              </div>

              {filteredDeltas.slice(0, 20).map(d => (
                <div
                  key={d.word}
                  className="grid px-4 py-2 items-center text-sm"
                  style={{
                    gridTemplateColumns: '1fr 3rem 3rem 5rem 5rem',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    color: 'rgba(255,255,255,0.75)',
                  }}
                >
                  <span className="font-medium">{d.word}</span>
                  <span className="text-right tabular-nums text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>{d.q1Count}</span>
                  <span className="text-right tabular-nums text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>{d.q2Count}</span>
                  <div className="flex justify-end pr-2">
                    <FreqBar q1={d.q1Count} q2={d.q2Count} />
                  </div>
                  <div className="flex justify-end">
                    <DeltaBadge delta={d.delta} pct={d.pctChange} />
                  </div>
                </div>
              ))}

              {filteredDeltas.length === 0 && (
                <div className="px-4 py-6 text-sm text-center" style={{ color: 'rgba(255,255,255,0.3)' }}>
                  No keyword deltas for this filter.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
