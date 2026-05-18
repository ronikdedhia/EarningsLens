'use client';

import { useState, useEffect, useCallback } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface SectorTheme {
  theme: string;
  summary: string;
  companies: string[];
  optimistic: string[];
  cautious: string[];
}

interface SectorEmergingTopic {
  topic: string;
  companies: string[];
  context: string;
}

interface SectorNarrative {
  sector: string;
  quarter: string;
  themes: SectorTheme[];
  emerging: SectorEmergingTopic[];
  generatedAt: string;
}

const SECTOR_ICONS: Record<string, string> = {
  Banking:      '🏦',
  Technology:   '💻',
  NBFC:         '📊',
  Conglomerate: '🏭',
};

function CompanyPill({
  ticker,
  type,
}: {
  ticker: string;
  type: 'optimistic' | 'cautious' | 'neutral';
}) {
  const styles = {
    optimistic: { bg: 'rgba(52,211,153,0.1)',  color: 'rgba(52,211,153,0.85)',  border: 'rgba(52,211,153,0.2)'  },
    cautious:   { bg: 'rgba(248,113,113,0.1)', color: 'rgba(248,113,113,0.85)', border: 'rgba(248,113,113,0.2)' },
    neutral:    { bg: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.5)', border: 'rgba(255,255,255,0.1)' },
  };
  const s = styles[type];
  return (
    <span
      className="text-[11px] font-mono font-medium px-2 py-0.5 rounded"
      style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}
    >
      {ticker}
    </span>
  );
}

function ThemeCard({ theme, rank }: { theme: SectorTheme; rank: number }) {
  const [open, setOpen] = useState(rank === 0);
  const total     = theme.companies.length;
  const optCount  = theme.optimistic.length;
  const cauCount  = theme.cautious.length;
  const neutCount = total - optCount - cauCount;

  return (
    <div
      className="rounded-2xl overflow-hidden transition-all duration-200"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {/* Header row — always visible */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="text-sm font-mono font-bold shrink-0 w-6 text-center"
            style={{ color: 'rgba(245,158,11,0.5)' }}
          >
            {rank + 1}
          </span>
          <span className="text-sm font-semibold truncate" style={{ color: 'rgba(255,255,255,0.88)' }}>
            {theme.theme}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Company count */}
          <span className="text-xs" style={{ color: 'rgba(255,255,255,0.35)' }}>
            {total} co{total !== 1 ? 's' : ''}
          </span>

          {/* Sentiment mini bar */}
          <div className="flex gap-px h-4 items-center">
            {optCount > 0 && (
              <div
                className="rounded-sm"
                style={{
                  width: `${Math.round((optCount / total) * 48)}px`,
                  minWidth: 6,
                  height: '100%',
                  background: '#34d399',
                }}
              />
            )}
            {neutCount > 0 && (
              <div
                className="rounded-sm"
                style={{
                  width: `${Math.round((neutCount / total) * 48)}px`,
                  minWidth: 6,
                  height: '100%',
                  background: 'rgba(148,163,184,0.3)',
                }}
              />
            )}
            {cauCount > 0 && (
              <div
                className="rounded-sm"
                style={{
                  width: `${Math.round((cauCount / total) * 48)}px`,
                  minWidth: 6,
                  height: '100%',
                  background: '#f87171',
                }}
              />
            )}
          </div>

          <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>
            {open ? '▲' : '▼'}
          </span>
        </div>
      </button>

      {/* Expanded content */}
      {open && (
        <div
          className="px-4 pb-4 space-y-3"
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
        >
          {/* Summary */}
          <p className="text-sm leading-relaxed pt-3" style={{ color: 'rgba(255,255,255,0.6)', fontStyle: 'italic' }}>
            {theme.summary}
          </p>

          {/* Company breakdown */}
          <div className="space-y-2">
            {theme.optimistic.length > 0 && (
              <div className="flex items-start gap-2 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-wider w-20 pt-0.5 shrink-0"
                  style={{ color: 'rgba(52,211,153,0.7)' }}>
                  Optimistic
                </span>
                <div className="flex flex-wrap gap-1">
                  {theme.optimistic.map(t => <CompanyPill key={t} ticker={t} type="optimistic" />)}
                </div>
              </div>
            )}
            {theme.cautious.length > 0 && (
              <div className="flex items-start gap-2 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-wider w-20 pt-0.5 shrink-0"
                  style={{ color: 'rgba(248,113,113,0.7)' }}>
                  Cautious
                </span>
                <div className="flex flex-wrap gap-1">
                  {theme.cautious.map(t => <CompanyPill key={t} ticker={t} type="cautious" />)}
                </div>
              </div>
            )}
            {(() => {
              const neutral = theme.companies.filter(
                t => !theme.optimistic.includes(t) && !theme.cautious.includes(t)
              );
              return neutral.length > 0 ? (
                <div className="flex items-start gap-2 flex-wrap">
                  <span className="text-[11px] font-semibold uppercase tracking-wider w-20 pt-0.5 shrink-0"
                    style={{ color: 'rgba(255,255,255,0.3)' }}>
                    Neutral
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {neutral.map(t => <CompanyPill key={t} ticker={t} type="neutral" />)}
                  </div>
                </div>
              ) : null;
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

function EvolutionRow({ narrative }: { narrative: SectorNarrative }) {
  return (
    <div
      className="rounded-xl p-3 space-y-2"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <p className="text-xs font-semibold font-mono" style={{ color: 'rgba(245,158,11,0.75)' }}>
        {narrative.quarter}
      </p>
      <div className="space-y-1">
        {narrative.themes.slice(0, 4).map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-[10px] tabular-nums w-4 shrink-0" style={{ color: 'rgba(255,255,255,0.25)' }}>
              {i + 1}.
            </span>
            <span className="text-xs truncate" style={{ color: 'rgba(255,255,255,0.65)' }}>{t.theme}</span>
            <div className="flex gap-px ml-auto shrink-0">
              {t.optimistic.length > 0 && (
                <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(52,211,153,0.15)', color: '#34d399' }}>
                  +{t.optimistic.length}
                </span>
              )}
              {t.cautious.length > 0 && (
                <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(248,113,113,0.15)', color: '#f87171' }}>
                  −{t.cautious.length}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SectorPulse() {
  const [sectors,       setSectors]       = useState<string[]>([]);
  const [quarters,      setQuarters]      = useState<string[]>([]);
  const [sector,        setSector]        = useState('');
  const [quarter,       setQuarter]       = useState('');
  const [narrative,     setNarrative]     = useState<SectorNarrative | null>(null);
  const [evolution,     setEvolution]     = useState<SectorNarrative[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [sectorsLoaded, setSectorsLoaded] = useState(false);
  const [error,         setError]         = useState('');

  // Load sector list once
  useEffect(() => {
    if (sectorsLoaded) return;
    fetch(`${API}/api/sector/sectors`)
      .then(r => r.json())
      .then(d => { setSectors(d.sectors ?? []); setSectorsLoaded(true); })
      .catch(() => {});
  }, [sectorsLoaded]);

  // Load available quarters when sector changes
  const handleSectorChange = useCallback(async (s: string) => {
    setSector(s);
    setQuarter('');
    setNarrative(null);
    setEvolution([]);
    setError('');
    if (!s) return;
    try {
      const res  = await fetch(`${API}/api/sector/quarters?sector=${encodeURIComponent(s)}`);
      const data = await res.json();
      const qs: string[] = data.quarters ?? [];
      setQuarters(qs);
      if (qs.length) setQuarter(qs[0]);
    } catch {
      setError('Could not load quarters for this sector.');
    }
  }, []);

  const analyse = useCallback(async (forceRefresh = false) => {
    if (!sector || !quarter) return;
    setLoading(true);
    setError('');
    setNarrative(null);
    try {
      const url = `${API}/api/sector?sector=${encodeURIComponent(sector)}&quarter=${encodeURIComponent(quarter)}${forceRefresh ? '&refresh=1' : ''}`;
      const res  = await fetch(url);
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? 'Analysis failed.');
        return;
      }
      const data: SectorNarrative = await res.json();
      setNarrative(data);

      // Load evolution history
      const evRes  = await fetch(`${API}/api/sector/evolution?sector=${encodeURIComponent(sector)}`);
      const evData = await evRes.json();
      setEvolution((evData.history ?? []).filter((n: SectorNarrative) => n.quarter !== quarter));
    } catch {
      setError('Analysis failed — check backend is running.');
    } finally {
      setLoading(false);
    }
  }, [sector, quarter]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h1
          className="text-3xl font-normal"
          style={{ fontFamily: 'var(--font-display), Georgia, serif', color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.02em' }}
        >
          Sector Pulse
        </h1>
        <p className="text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>
          Top themes, sentiment divergence, and emerging narratives across an entire sector — extracted from earnings call transcripts.
        </p>
      </div>

      {/* Sector selector */}
      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.3)' }}>
          Select sector
        </p>
        <div className="flex flex-wrap gap-2">
          {sectors.length === 0 && (
            <span className="text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>Loading sectors…</span>
          )}
          {sectors.map(s => (
            <button
              key={s}
              onClick={() => handleSectorChange(s)}
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-2xl transition-all"
              style={{
                background: sector === s ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.04)',
                border:     sector === s ? '1px solid rgba(245,158,11,0.3)' : '1px solid rgba(255,255,255,0.08)',
                color:      sector === s ? '#f59e0b' : 'rgba(255,255,255,0.6)',
                boxShadow:  sector === s ? '0 0 16px rgba(245,158,11,0.1)' : 'none',
              }}
            >
              <span>{SECTOR_ICONS[s] ?? '◈'}</span>
              <span>{s}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Quarter selector + analyse button */}
      {sector && (
        <div className="flex items-center gap-3 flex-wrap">
          <select
            className="glass-input text-sm rounded-xl px-3 py-2"
            value={quarter}
            onChange={e => setQuarter(e.target.value)}
            disabled={!quarters.length}
          >
            {!quarters.length && <option value="">No quarters found</option>}
            {quarters.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
          <button
            onClick={() => analyse(false)}
            disabled={!quarter || loading}
            className="px-5 py-2 text-sm font-semibold rounded-xl transition-all disabled:opacity-40"
            style={{ background: 'rgba(245,158,11,0.9)', color: '#111' }}
          >
            {loading ? 'Analysing…' : `Analyse ${sector}`}
          </button>
          {narrative && (
            <button
              onClick={() => analyse(true)}
              disabled={loading}
              className="px-4 py-2 text-xs font-medium rounded-xl border transition-all disabled:opacity-40"
              style={{ borderColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.45)', background: 'rgba(255,255,255,0.03)' }}
            >
              ↺ Refresh
            </button>
          )}
        </div>
      )}

      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}

      {loading && (
        <div className="py-16 text-center space-y-2">
          <div className="animate-spin inline-block text-2xl">⟳</div>
          <p className="text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>
            Fetching transcripts from {sector} companies and running sector analysis…
          </p>
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.2)' }}>
            This takes 15–30 seconds for the first run. Results are cached.
          </p>
        </div>
      )}

      {/* Results */}
      {narrative && !loading && (
        <div className="space-y-6">
          {/* Meta row */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-base font-semibold" style={{ color: 'rgba(255,255,255,0.7)' }}>
              {SECTOR_ICONS[narrative.sector] ?? '◈'} {narrative.sector} — {narrative.quarter}
            </span>
            <span className="text-xs" style={{ color: 'rgba(255,255,255,0.25)' }}>
              Generated {new Date(narrative.generatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
            </span>
          </div>

          {/* Main layout: themes + sidebar */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Themes — 2/3 width */}
            <div className="lg:col-span-2 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'rgba(255,255,255,0.3)' }}>
                Top themes this quarter
              </p>
              {narrative.themes.length === 0 && (
                <p className="text-sm" style={{ color: 'rgba(255,255,255,0.35)' }}>
                  No themes extracted. Try a quarter with more companies ingested.
                </p>
              )}
              {narrative.themes.map((t, i) => (
                <ThemeCard key={i} theme={t} rank={i} />
              ))}
            </div>

            {/* Sidebar — 1/3 width */}
            <div className="space-y-5">
              {/* Emerging topics */}
              {narrative.emerging.length > 0 && (
                <div
                  className="rounded-2xl p-4 space-y-3"
                  style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.12)' }}
                >
                  <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'rgba(245,158,11,0.6)' }}>
                    ✦ Emerging this quarter
                  </p>
                  {narrative.emerging.map((e, i) => (
                    <div key={i} className="space-y-1.5">
                      <div className="flex items-start gap-2 flex-wrap">
                        <span className="text-sm font-semibold" style={{ color: 'rgba(255,255,255,0.8)' }}>
                          {e.topic}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)' }}>
                        {e.context}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {e.companies.map(t => (
                          <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(245,158,11,0.1)', color: 'rgba(245,158,11,0.7)' }}>
                            {t}
                          </span>
                        ))}
                      </div>
                      {i < narrative.emerging.length - 1 && (
                        <div style={{ borderBottom: '1px solid rgba(245,158,11,0.1)', marginTop: 8 }} />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Legend */}
              <div
                className="rounded-2xl p-4 space-y-2"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'rgba(255,255,255,0.25)' }}>
                  Legend
                </p>
                <div className="space-y-1.5 text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  <div className="flex items-center gap-2">
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: '#34d399', display: 'inline-block', flexShrink: 0 }} />
                    Management sounds positive/confident
                  </div>
                  <div className="flex items-center gap-2">
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: '#f87171', display: 'inline-block', flexShrink: 0 }} />
                    Management sounds defensive/worried
                  </div>
                  <div className="flex items-center gap-2">
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: 'rgba(148,163,184,0.3)', display: 'inline-block', flexShrink: 0 }} />
                    Mentioned, neutral tone
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Evolution timeline */}
          {evolution.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.3)' }}>
                Sector narrative evolution
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {evolution.slice(0, 4).map(n => (
                  <EvolutionRow key={n.quarter} narrative={n} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty state when sector selected but not yet analysed */}
      {!loading && sector && !narrative && !error && quarters.length > 0 && (
        <div
          className="rounded-2xl p-8 text-center text-sm space-y-2"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}
        >
          <p className="text-2xl mb-3">{SECTOR_ICONS[sector] ?? '◈'}</p>
          <p>Select a quarter and click <strong style={{ color: 'rgba(255,255,255,0.6)' }}>Analyse {sector}</strong></p>
          <p style={{ color: 'rgba(255,255,255,0.2)' }}>First run takes 15–30s. Results are cached for instant reload.</p>
        </div>
      )}
    </div>
  );
}
