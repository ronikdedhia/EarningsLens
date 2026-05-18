'use client';

import { useState, useEffect, useCallback } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface GuidancePromise {
  id: number;
  ticker: string;
  quarterPromised: string;
  speaker: string;
  category: string;
  verbatimQuote: string;
  timeframe: string;
  confidenceScore: number;
  directLanguage: boolean;
  status: 'pending' | 'delivered' | 'partial' | 'missed';
  resolutionNote: string;
  resolvedInQuarter: string;
  createdAt: string;
}

const STATUS_CONFIG = {
  pending:   { label: 'Pending',   color: 'rgba(148,163,184,0.7)',  bg: 'rgba(148,163,184,0.08)',  dot: '#94a3b8' },
  delivered: { label: 'Delivered', color: 'rgba(52,211,153,0.9)',   bg: 'rgba(52,211,153,0.08)',   dot: '#34d399' },
  partial:   { label: 'Partial',   color: 'rgba(251,191,36,0.9)',   bg: 'rgba(251,191,36,0.08)',   dot: '#fbbf24' },
  missed:    { label: 'Missed',    color: 'rgba(248,113,113,0.9)',  bg: 'rgba(248,113,113,0.08)',  dot: '#f87171' },
};

const CATEGORIES = ['All', 'Revenue', 'Margin', 'Volume', 'Capex', 'Hiring', 'Product', 'Regulatory', 'Dividend', 'Guidance', 'Other'];

function ConfidenceDots({ score }: { score: number }) {
  return (
    <span className="flex gap-0.5 items-center">
      {[1, 2, 3, 4, 5].map(i => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: 6, height: 6,
            borderRadius: '50%',
            background: i <= score ? '#f59e0b' : 'rgba(255,255,255,0.1)',
          }}
        />
      ))}
    </span>
  );
}

function StatusBadge({ status }: { status: GuidancePromise['status'] }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full"
      style={{ color: cfg.color, background: cfg.bg }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.dot, display: 'inline-block' }} />
      {cfg.label}
    </span>
  );
}

function PromiseCard({ p, expanded, onToggle }: {
  p: GuidancePromise;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="rounded-2xl p-4 cursor-pointer transition-all duration-200"
      style={{
        background: expanded ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.025)',
        border: expanded ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(255,255,255,0.06)',
      }}
      onClick={onToggle}
    >
      {/* Row 1: category + status + quarter */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded"
            style={{ background: 'rgba(245,158,11,0.12)', color: 'rgba(245,158,11,0.8)' }}
          >
            {p.category}
          </span>
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
            {p.quarterPromised}
          </span>
          {p.speaker && (
            <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
              · {p.speaker}
            </span>
          )}
        </div>
        <StatusBadge status={p.status} />
      </div>

      {/* Quote */}
      <p
        className="text-sm leading-relaxed mb-2"
        style={{
          color: 'rgba(255,255,255,0.82)',
          fontFamily: 'var(--font-display), Georgia, serif',
          fontStyle: 'italic',
        }}
      >
        "{p.verbatimQuote}"
      </p>

      {/* Row 2: confidence + timeframe + directness */}
      <div className="flex items-center gap-3 flex-wrap">
        <ConfidenceDots score={p.confidenceScore} />
        {p.timeframe && (
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.4)' }}>
            ⏱ {p.timeframe}
          </span>
        )}
        {p.directLanguage && (
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(52,211,153,0.1)', color: 'rgba(52,211,153,0.7)' }}>
            Direct language
          </span>
        )}
      </div>

      {/* Expanded: resolution details */}
      {expanded && p.status !== 'pending' && (
        <div
          className="mt-3 pt-3 text-sm leading-relaxed"
          style={{
            borderTop: '1px solid rgba(255,255,255,0.06)',
            color: 'rgba(255,255,255,0.55)',
          }}
        >
          {p.resolvedInQuarter && (
            <span className="text-[11px] font-medium mr-2" style={{ color: STATUS_CONFIG[p.status].color }}>
              Checked in {p.resolvedInQuarter} ·
            </span>
          )}
          {p.resolutionNote || 'No resolution note.'}
        </div>
      )}
    </div>
  );
}

function ScoreBar({ label, delivered, partial, missed, pending }: {
  label: string;
  delivered: number; partial: number; missed: number; pending: number;
}) {
  const total = delivered + partial + missed + pending;
  if (!total) return null;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs w-20 shrink-0" style={{ color: 'rgba(255,255,255,0.45)' }}>{label}</span>
      <div className="flex-1 flex rounded-full overflow-hidden h-2 gap-px">
        {delivered > 0 && <div style={{ width: pct(delivered), background: '#34d399' }} />}
        {partial   > 0 && <div style={{ width: pct(partial),   background: '#fbbf24' }} />}
        {missed    > 0 && <div style={{ width: pct(missed),    background: '#f87171' }} />}
        {pending   > 0 && <div style={{ width: pct(pending),   background: 'rgba(148,163,184,0.25)' }} />}
      </div>
      <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'rgba(255,255,255,0.35)' }}>
        {total}
      </span>
    </div>
  );
}

export default function GuidancePromises() {
  const [ticker, setTicker]         = useState('');
  const [inputTicker, setInput]     = useState('');
  const [promises, setPromises]     = useState<GuidancePromise[]>([]);
  const [loading, setLoading]       = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>('All');
  const [filterCat,    setFilterCat]    = useState<string>('All');
  const [filterQuarter, setFilterQuarter] = useState<string>('All');
  const [expandedId,   setExpandedId]   = useState<number | null>(null);
  const [error,        setError]        = useState('');

  const fetchPromises = useCallback(async (t: string) => {
    setLoading(true);
    setError('');
    try {
      const res  = await fetch(`${API}/api/promises?ticker=${encodeURIComponent(t)}`);
      const data = await res.json();
      setPromises(data.promises ?? []);
    } catch {
      setError('Could not load promises.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = () => {
    const t = inputTicker.trim().toUpperCase();
    if (!t) return;
    setTicker(t);
    setFilterStatus('All');
    setFilterCat('All');
    setFilterQuarter('All');
    fetchPromises(t);
  };

  const handleExtract = async () => {
    const quarter = window.prompt('Which quarter to extract promises from? (e.g. Q3FY25)');
    if (!quarter || !ticker) return;
    setExtracting(true);
    try {
      const res  = await fetch(`${API}/api/promises/extract`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticker, quarter: quarter.trim() }),
      });
      const data = await res.json();
      setPromises(prev => {
        const existingIds = new Set(prev.map(p => p.id));
        const newOnes = (data.promises ?? []).filter((p: GuidancePromise) => !existingIds.has(p.id));
        return [...prev, ...newOnes];
      });
    } catch {
      setError('Extraction failed.');
    } finally {
      setExtracting(false);
    }
  };

  // Derived
  const quarters = ['All', ...Array.from(new Set(promises.map(p => p.quarterPromised))).sort().reverse()];

  const visible = promises.filter(p => {
    if (filterStatus !== 'All' && p.status !== filterStatus.toLowerCase()) return false;
    if (filterCat    !== 'All' && p.category !== filterCat) return false;
    if (filterQuarter !== 'All' && p.quarterPromised !== filterQuarter) return false;
    return true;
  });

  // Summary stats by quarter
  const quarterStats = Array.from(new Set(promises.map(p => p.quarterPromised)))
    .sort()
    .reverse()
    .map(q => {
      const qp = promises.filter(p => p.quarterPromised === q);
      return {
        quarter:   q,
        delivered: qp.filter(p => p.status === 'delivered').length,
        partial:   qp.filter(p => p.status === 'partial').length,
        missed:    qp.filter(p => p.status === 'missed').length,
        pending:   qp.filter(p => p.status === 'pending').length,
      };
    });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h1
          className="text-3xl font-normal"
          style={{ fontFamily: 'var(--font-display), Georgia, serif', color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.02em' }}
        >
          Guidance Promise Tracker
        </h1>
        <p className="text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>
          AI-extracted forward-looking commitments from earnings call transcripts, tracked across quarters.
        </p>
      </div>

      {/* Search bar */}
      <div className="flex gap-2">
        <input
          className="glass-input flex-1 rounded-xl px-4 py-2.5 text-sm font-mono uppercase"
          placeholder="Enter ticker (e.g. HDFCBANK)"
          value={inputTicker}
          onChange={e => setInput(e.target.value.toUpperCase())}
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
        {ticker && (
          <button
            onClick={handleExtract}
            disabled={extracting}
            className="px-5 py-2.5 text-sm font-medium rounded-xl border transition-all disabled:opacity-40"
            style={{ borderColor: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.7)', background: 'rgba(255,255,255,0.04)' }}
          >
            {extracting ? 'Extracting…' : '+ Extract'}
          </button>
        )}
      </div>

      {error && (
        <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>
      )}

      {loading && (
        <div className="text-sm py-8 text-center" style={{ color: 'rgba(255,255,255,0.3)' }}>
          <span className="animate-spin inline-block mr-2">⟳</span> Loading promises…
        </div>
      )}

      {!loading && ticker && promises.length === 0 && (
        <div
          className="rounded-2xl p-8 text-center text-sm space-y-2"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}
        >
          <p>No promises extracted for {ticker} yet.</p>
          <p>Click <strong style={{ color: 'rgba(255,255,255,0.55)' }}>+ Extract</strong> to run AI extraction on a quarter.</p>
        </div>
      )}

      {!loading && promises.length > 0 && (
        <div className="space-y-6">
          {/* Summary heatmap */}
          <div
            className="rounded-2xl p-5 space-y-3"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.35)' }}>
                Delivery track record
              </p>
              <div className="flex items-center gap-3 text-[10px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
                <span><span style={{ color: '#34d399' }}>■</span> Delivered</span>
                <span><span style={{ color: '#fbbf24' }}>■</span> Partial</span>
                <span><span style={{ color: '#f87171' }}>■</span> Missed</span>
                <span><span style={{ color: 'rgba(148,163,184,0.4)' }}>■</span> Pending</span>
              </div>
            </div>
            <div className="space-y-2">
              {quarterStats.map(qs => (
                <ScoreBar key={qs.quarter} {...qs} label={qs.quarter} />
              ))}
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-2 items-center">
            {/* Status filter */}
            <div className="flex gap-1">
              {['All', 'Pending', 'Delivered', 'Partial', 'Missed'].map(s => (
                <button
                  key={s}
                  onClick={() => setFilterStatus(s)}
                  className="px-3 py-1 text-xs font-medium rounded-lg transition-all"
                  style={{
                    background: filterStatus === s ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.04)',
                    color:      filterStatus === s ? '#f59e0b' : 'rgba(255,255,255,0.45)',
                    border:     filterStatus === s ? '1px solid rgba(245,158,11,0.25)' : '1px solid rgba(255,255,255,0.07)',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>

            {/* Quarter filter */}
            <select
              className="glass-input text-xs rounded-lg px-2 py-1"
              value={filterQuarter}
              onChange={e => setFilterQuarter(e.target.value)}
            >
              {quarters.map(q => <option key={q} value={q}>{q}</option>)}
            </select>

            {/* Category filter */}
            <select
              className="glass-input text-xs rounded-lg px-2 py-1"
              value={filterCat}
              onChange={e => setFilterCat(e.target.value)}
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>

            <span className="text-xs ml-auto" style={{ color: 'rgba(255,255,255,0.3)' }}>
              {visible.length} of {promises.length}
            </span>
          </div>

          {/* Promise cards */}
          <div className="space-y-2">
            {visible.length === 0 && (
              <p className="text-sm text-center py-6" style={{ color: 'rgba(255,255,255,0.3)' }}>
                No promises match current filters.
              </p>
            )}
            {visible.map(p => (
              <PromiseCard
                key={p.id}
                p={p}
                expanded={expandedId === p.id}
                onToggle={() => setExpandedId(expandedId === p.id ? null : p.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
