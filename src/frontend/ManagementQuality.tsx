'use client';

import { useState, useEffect } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface ManagementScore {
  quarter:       string;
  confidence:    number;
  transparency:  number;
  followThrough: number;
  composite:     number;
  summary:       string;
  hedgeWords:    string[];
  prevPromises:  string[];
  deliveryNote:  string;
}

interface CompanyInfo {
  ticker: string;
  quarters: { status: string }[];
}

function prevQuarterOf(q: string): string | null {
  const m = q.match(/^Q(\d)FY(\d{2,4})$/);
  if (!m) return null;
  let qn = parseInt(m[1]);
  let fy = parseInt(m[2]) < 100 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
  if (qn === 1) { qn = 4; fy -= 1; }
  else { qn -= 1; }
  return `Q${qn}FY${String(fy).slice(-2)}`;
}

function compositeColor(score: number): string {
  if (score >= 70) return '#34d399';
  if (score >= 50) return '#fbbf24';
  return '#f87171';
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span style={{ color: 'rgba(255,255,255,0.45)' }}>{label}</span>
        <span style={{ color }}>{value}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${value}%`, background: color }}
        />
      </div>
    </div>
  );
}

function QuarterCard({ score }: { score: ManagementScore }) {
  const [open, setOpen] = useState(false);
  const color     = compositeColor(score.composite);
  const prevLabel = prevQuarterOf(score.quarter);

  return (
    <div className="glass rounded-2xl overflow-hidden" style={{ border: `1px solid ${color}22` }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-4 text-left flex items-start gap-4 transition-colors"
        style={{ background: open ? 'rgba(255,255,255,0.04)' : 'transparent' }}
      >
        <div
          className="shrink-0 w-14 h-14 rounded-xl flex flex-col items-center justify-center"
          style={{ background: `${color}15`, border: `1.5px solid ${color}40` }}
        >
          <span className="text-xl font-bold leading-none" style={{ color }}>{score.composite}</span>
          <span className="text-[9px] uppercase tracking-wider mt-0.5" style={{ color: `${color}99` }}>/ 100</span>
        </div>
        <div className="flex-1 min-w-0">
          <span className="font-mono font-semibold text-sm text-amber-400">{score.quarter}</span>
          <p className="text-xs mt-1 line-clamp-2" style={{ color: 'rgba(255,255,255,0.5)' }}>
            {score.summary || 'No summary available.'}
          </p>
        </div>
        <span className="text-xs shrink-0 mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="pt-3 space-y-2.5">
            <ScoreBar label="Confidence"     value={score.confidence}    color="#34d399" />
            <ScoreBar label="Transparency"   value={score.transparency}  color="#60a5fa" />
            <ScoreBar label="Follow-through" value={score.followThrough} color="#a78bfa" />
          </div>

          {score.hedgeWords.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest mb-2 text-amber-400">
                Hedging Language
              </p>
              <div className="flex flex-wrap gap-1.5">
                {score.hedgeWords.map((w, i) => (
                  <span
                    key={i}
                    className="text-xs px-2 py-0.5 rounded-md"
                    style={{ background: 'rgba(251,191,36,0.08)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}
                  >
                    &ldquo;{w}&rdquo;
                  </span>
                ))}
              </div>
            </div>
          )}

          {score.prevPromises.length > 0 && (
            <div
              className="rounded-xl p-3 space-y-2"
              style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}
            >
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#a78bfa' }}>
                {prevLabel ? `What ${prevLabel} promised` : 'Prior quarter commitments'}
              </p>
              <ul className="space-y-1.5">
                {score.prevPromises.map((p, i) => (
                  <li key={i} className="text-xs flex gap-2" style={{ color: 'rgba(255,255,255,0.55)' }}>
                    <span style={{ color: '#a78bfa' }}>•</span>
                    <span>&ldquo;{p}&rdquo;</span>
                  </li>
                ))}
              </ul>
              {score.deliveryNote && (
                <div
                  className="flex gap-2 pt-2"
                  style={{ borderTop: '1px solid rgba(167,139,250,0.12)' }}
                >
                  <span style={{ color: '#a78bfa' }}>◆</span>
                  <p className="text-xs" style={{ color: 'rgba(255,255,255,0.65)' }}>{score.deliveryNote}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ManagementQuality() {
  const [companies, setCompanies] = useState<CompanyInfo[]>([]);
  const [ticker,    setTicker]    = useState('');
  const [scores,    setScores]    = useState<ManagementScore[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error,     setError]     = useState('');

  useEffect(() => {
    fetch(`${API}/api/companies`)
      .then(r => r.json())
      .then(d => {
        const ingested: CompanyInfo[] = (d.companies ?? []).filter(
          (c: CompanyInfo) => c.quarters.some(q => q.status === 'ingested')
        );
        setCompanies(ingested);
        if (ingested.length) setTicker(ingested[0].ticker);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!ticker) return;
    setLoading(true);
    setScores([]);
    setError('');
    fetch(`${API}/api/management?ticker=${ticker}`)
      .then(r => r.json())
      .then(d => setScores([...(d.scores ?? [])].reverse()))
      .catch(() => setError('Failed to load scores.'))
      .finally(() => setLoading(false));
  }, [ticker]);

  async function handleAnalyze() {
    if (!ticker || analyzing) return;
    setAnalyzing(true);
    setError('');
    try {
      const res  = await fetch(`${API}/api/management/analyze`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticker }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Analysis failed.'); return; }
      setScores([...(data.scores ?? [])].reverse());
    } catch {
      setError('Could not reach server.');
    } finally {
      setAnalyzing(false);
    }
  }

  const avgComposite = scores.length
    ? Math.round(scores.reduce((s, r) => s + r.composite, 0) / scores.length)
    : null;

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="glass rounded-2xl p-5 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">Management Quality</p>
        <div className="flex gap-3 flex-wrap">
          <select
            value={ticker}
            onChange={e => { setTicker(e.target.value); }}
            className="flex-1 rounded-xl px-3 py-2 text-sm outline-none"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border:     '1px solid rgba(255,255,255,0.1)',
              color:      ticker ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.4)',
            }}
          >
            {companies.length === 0 && <option value="">No ingested companies</option>}
            {companies.map(c => (
              <option key={c.ticker} value={c.ticker} style={{ background: '#1a1a2e' }}>
                {c.ticker}
              </option>
            ))}
          </select>
          <button
            onClick={handleAnalyze}
            disabled={!ticker || analyzing}
            className="px-5 py-2 bg-amber-400 text-gray-900 font-semibold text-sm rounded-xl
                       hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed transition-all
                       shadow-[0_0_20px_rgba(245,158,11,0.3)]"
          >
            {analyzing
              ? <span className="flex items-center gap-2"><span className="animate-spin inline-block">⟳</span>Analyzing…</span>
              : scores.length ? 'Re-analyze' : 'Analyze'}
          </button>
        </div>
        {analyzing && (
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.35)' }}>
            Running AI analysis across all ingested quarters — may take 30–90 seconds…
          </p>
        )}
        {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
      </div>

      {/* Summary strip */}
      {avgComposite !== null && (
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Quarters Analyzed', value: String(scores.length),         color: 'rgba(255,255,255,0.9)' },
            { label: 'Avg Composite',      value: String(avgComposite),          color: compositeColor(avgComposite) },
            { label: 'Latest Quarter',     value: scores[0]?.quarter ?? '—',    color: compositeColor(scores[0]?.composite ?? 50) },
          ].map(s => (
            <div key={s.label} className="glass rounded-2xl p-4 text-center">
              <div className="text-2xl font-bold" style={{ color: s.color }}>{s.value}</div>
              <div className="text-xs mt-1 uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.35)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Score legend */}
      {scores.length > 0 && (
        <div className="flex gap-4 text-xs" style={{ color: 'rgba(255,255,255,0.35)' }}>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: '#34d399' }} />Confidence</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: '#60a5fa' }} />Transparency</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: '#a78bfa' }} />Follow-through</span>
        </div>
      )}

      {/* Quarter cards */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>
          Loading…
        </div>
      ) : scores.length === 0 && !analyzing ? (
        <div className="text-center py-16 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>
          {ticker
            ? 'No analysis yet — click Analyze to run management quality scoring.'
            : 'Ingest transcripts first via the Coverage tab.'}
        </div>
      ) : (
        <div className="space-y-3">
          {scores.map(s => <QuarterCard key={s.quarter} score={s} />)}
        </div>
      )}
    </div>
  );
}
