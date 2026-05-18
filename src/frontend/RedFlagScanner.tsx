'use client';

import { useState, useCallback } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface RedFlag {
  id: number;
  ticker: string;
  quarter: string;
  flagType: string;
  severity: 'Low' | 'Medium' | 'High';
  evidence: string;
  detectedAt: string;
}

const FLAG_LABELS: Record<string, string> = {
  exceptional_charges:           'Exceptional Charges',
  deflected_questions:           'Deflected Questions',
  regulatory_language_spike:     'Regulatory Language Spike',
  accounting_terminology_change: 'Accounting Terminology Change',
  leadership_change:             'Leadership Change',
  compensating_language:         'Compensating Language',
  analyst_adversarial:           'Analyst Pressure',
  guidance_range_widening:       'Guidance Range Widening',
  capex_guidance_cut:            'Capex Guidance Cut',
};

const FLAG_ICONS: Record<string, string> = {
  exceptional_charges:           '💸',
  deflected_questions:           '↺',
  regulatory_language_spike:     '⚖',
  accounting_terminology_change: '⇄',
  leadership_change:             '⟳',
  compensating_language:         '◉',
  analyst_adversarial:           '⚡',
  guidance_range_widening:       '⤢',
  capex_guidance_cut:            '↓',
};

const SEVERITY_CONFIG = {
  High:   { bg: 'rgba(248,113,113,0.1)',  border: 'rgba(248,113,113,0.25)', label: 'rgba(248,113,113,0.9)',  dot: '#f87171' },
  Medium: { bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.2)',  label: 'rgba(251,191,36,0.85)', dot: '#fbbf24' },
  Low:    { bg: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.15)', label: 'rgba(148,163,184,0.7)', dot: '#94a3b8' },
};

function SeverityBadge({ s }: { s: 'Low' | 'Medium' | 'High' }) {
  const c = SEVERITY_CONFIG[s];
  return (
    <span
      className="flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
      style={{ color: c.label, background: c.bg, border: `1px solid ${c.border}` }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.dot, display: 'inline-block' }} />
      {s}
    </span>
  );
}

function FlagCard({ flag }: { flag: RedFlag }) {
  const cfg = SEVERITY_CONFIG[flag.severity];
  return (
    <div
      className="rounded-2xl p-4 space-y-2"
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-base leading-none">{FLAG_ICONS[flag.flagType] ?? '⚑'}</span>
          <span className="text-sm font-semibold" style={{ color: 'rgba(255,255,255,0.85)' }}>
            {FLAG_LABELS[flag.flagType] ?? flag.flagType}
          </span>
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
            {flag.quarter}
          </span>
        </div>
        <SeverityBadge s={flag.severity} />
      </div>
      {flag.evidence && (
        <p
          className="text-sm leading-relaxed"
          style={{
            color: 'rgba(255,255,255,0.6)',
            fontFamily: 'var(--font-display), Georgia, serif',
            fontStyle: 'italic',
            borderLeft: `2px solid ${cfg.dot}`,
            paddingLeft: '10px',
          }}
        >
          "{flag.evidence}"
        </p>
      )}
    </div>
  );
}

function FeedCard({ flag }: { flag: RedFlag }) {
  const cfg = SEVERITY_CONFIG[flag.severity];
  return (
    <div
      className="flex items-start gap-3 px-4 py-3 rounded-xl"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <span className="text-base leading-none mt-0.5">{FLAG_ICONS[flag.flagType] ?? '⚑'}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className="text-sm font-semibold font-mono" style={{ color: '#f59e0b' }}>{flag.ticker}</span>
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.4)' }}>{flag.quarter}</span>
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>·</span>
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
            {FLAG_LABELS[flag.flagType] ?? flag.flagType}
          </span>
          <SeverityBadge s={flag.severity} />
        </div>
        {flag.evidence && (
          <p className="text-xs truncate" style={{ color: 'rgba(255,255,255,0.4)', fontStyle: 'italic' }}>
            "{flag.evidence}"
          </p>
        )}
      </div>
    </div>
  );
}

export default function RedFlagScanner() {
  const [tab, setTab]             = useState<'company' | 'feed'>('feed');
  const [inputTicker, setInput]   = useState('');
  const [ticker, setTicker]       = useState('');
  const [flags, setFlags]         = useState<RedFlag[]>([]);
  const [feed, setFeed]           = useState<RedFlag[]>([]);
  const [loading, setLoading]     = useState(false);
  const [feedLoaded, setFeedLoaded] = useState(false);
  const [scanning, setScanning]   = useState(false);
  const [error, setError]         = useState('');
  const [filterSev, setFilterSev] = useState<string>('All');

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await fetch(`${API}/api/redflags/feed?days=7`);
      const data = await res.json();
      setFeed(data.flags ?? []);
      setFeedLoaded(true);
    } catch {
      setError('Could not load feed.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCompany = useCallback(async (t: string) => {
    setLoading(true);
    setError('');
    try {
      const res  = await fetch(`${API}/api/redflags?ticker=${encodeURIComponent(t)}`);
      const data = await res.json();
      setFlags(data.flags ?? []);
    } catch {
      setError('Could not load flags.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = () => {
    const t = inputTicker.trim().toUpperCase();
    if (!t) return;
    setTicker(t);
    setTab('company');
    loadCompany(t);
  };

  const handleScan = async () => {
    const quarter = window.prompt('Quarter to scan? (e.g. Q3FY25)');
    if (!quarter || !ticker) return;
    setScanning(true);
    try {
      const res  = await fetch(`${API}/api/redflags/scan`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticker, quarter: quarter.trim() }),
      });
      const data = await res.json();
      setFlags(prev => {
        const existingIds = new Set(prev.map(f => f.id));
        const newOnes = (data.flags ?? []).filter((f: RedFlag) => !existingIds.has(f.id));
        const sOrder: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
        return [...prev, ...newOnes].sort((a, b) => sOrder[a.severity] - sOrder[b.severity]);
      });
    } catch {
      setError('Scan failed.');
    } finally {
      setScanning(false);
    }
  };

  // Load feed on mount
  if (!feedLoaded && !loading && tab === 'feed') {
    loadFeed();
  }

  const visibleFlags = flags.filter(f => filterSev === 'All' || f.severity === filterSev);

  const highCount   = flags.filter(f => f.severity === 'High').length;
  const medCount    = flags.filter(f => f.severity === 'Medium').length;

  // Group feed by severity for counts
  const feedHigh = feed.filter(f => f.severity === 'High').length;
  const feedMed  = feed.filter(f => f.severity === 'Medium').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h1
          className="text-3xl font-normal"
          style={{ fontFamily: 'var(--font-display), Georgia, serif', color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.02em' }}
        >
          Red Flag Scanner
        </h1>
        <p className="text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>
          AI-powered qualitative risk detection across earnings call transcripts.
        </p>
      </div>

      {/* Search + tab toggle */}
      <div className="flex gap-2 flex-wrap">
        <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <button
            onClick={() => { setTab('feed'); if (!feedLoaded) loadFeed(); }}
            className="px-4 py-1.5 text-sm font-medium rounded-lg transition-all"
            style={{
              background: tab === 'feed' ? 'rgba(248,113,113,0.15)' : 'transparent',
              color:      tab === 'feed' ? '#f87171' : 'rgba(255,255,255,0.45)',
            }}
          >
            Site-wide Feed
            {feedHigh > 0 && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                style={{ background: 'rgba(248,113,113,0.2)', color: '#f87171' }}>
                {feedHigh} High
              </span>
            )}
          </button>
          <button
            onClick={() => setTab('company')}
            className="px-4 py-1.5 text-sm font-medium rounded-lg transition-all"
            style={{
              background: tab === 'company' ? 'rgba(248,113,113,0.15)' : 'transparent',
              color:      tab === 'company' ? '#f87171' : 'rgba(255,255,255,0.45)',
            }}
          >
            Company
          </button>
        </div>

        <input
          className="glass-input flex-1 rounded-xl px-4 py-2 text-sm font-mono uppercase min-w-[160px]"
          placeholder="Ticker (e.g. HDFCBANK)"
          value={inputTicker}
          onChange={e => setInput(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
        />
        <button
          onClick={handleSearch}
          disabled={!inputTicker.trim()}
          className="px-4 py-2 text-sm font-semibold rounded-xl transition-all disabled:opacity-40"
          style={{ background: 'rgba(248,113,113,0.85)', color: '#fff' }}
        >
          Load
        </button>
        {ticker && tab === 'company' && (
          <button
            onClick={handleScan}
            disabled={scanning}
            className="px-4 py-2 text-sm font-medium rounded-xl border transition-all disabled:opacity-40"
            style={{ borderColor: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.7)', background: 'rgba(255,255,255,0.04)' }}
          >
            {scanning ? 'Scanning…' : '⚑ Scan'}
          </button>
        )}
      </div>

      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}

      {loading && (
        <div className="text-sm py-8 text-center" style={{ color: 'rgba(255,255,255,0.3)' }}>
          <span className="animate-spin inline-block mr-2">⟳</span>
          {tab === 'feed' ? 'Loading feed…' : 'Loading flags…'}
        </div>
      )}

      {/* FEED TAB */}
      {!loading && tab === 'feed' && (
        <div className="space-y-4">
          {/* Feed stats */}
          {feed.length > 0 && (
            <div className="flex gap-3 flex-wrap">
              <div className="rounded-xl px-4 py-2.5 text-center" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
                <div className="text-2xl font-bold tabular-nums" style={{ color: '#f87171' }}>{feedHigh}</div>
                <div className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: 'rgba(248,113,113,0.6)' }}>High severity</div>
              </div>
              <div className="rounded-xl px-4 py-2.5 text-center" style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}>
                <div className="text-2xl font-bold tabular-nums" style={{ color: '#fbbf24' }}>{feedMed}</div>
                <div className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: 'rgba(251,191,36,0.6)' }}>Medium severity</div>
              </div>
              <div className="rounded-xl px-4 py-2.5 text-center" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="text-2xl font-bold tabular-nums" style={{ color: 'rgba(255,255,255,0.7)' }}>{feed.length}</div>
                <div className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>Total (7d)</div>
              </div>
            </div>
          )}
          <div className="space-y-2">
            {feed.length === 0 && (
              <p className="text-sm text-center py-8" style={{ color: 'rgba(255,255,255,0.3)' }}>
                No flags detected in the last 7 days. Ingest new transcripts to auto-scan.
              </p>
            )}
            {feed.map(f => <FeedCard key={f.id} flag={f} />)}
          </div>
        </div>
      )}

      {/* COMPANY TAB */}
      {!loading && tab === 'company' && (
        <div className="space-y-4">
          {ticker && flags.length === 0 && (
            <div
              className="rounded-2xl p-8 text-center text-sm space-y-2"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}
            >
              <p>No red flags found for {ticker}.</p>
              <p>Click <strong style={{ color: 'rgba(255,255,255,0.55)' }}>⚑ Scan</strong> to run AI detection on a quarter.</p>
            </div>
          )}

          {flags.length > 0 && (
            <>
              {/* Summary row */}
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-semibold font-mono" style={{ color: '#f59e0b' }}>{ticker}</span>
                <div className="flex gap-1">
                  {['All', 'High', 'Medium', 'Low'].map(s => (
                    <button
                      key={s}
                      onClick={() => setFilterSev(s)}
                      className="px-3 py-1 text-xs font-medium rounded-lg transition-all"
                      style={{
                        background: filterSev === s ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.04)',
                        color:      filterSev === s ? '#f87171'                 : 'rgba(255,255,255,0.45)',
                        border:     filterSev === s ? '1px solid rgba(248,113,113,0.25)' : '1px solid rgba(255,255,255,0.07)',
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {highCount > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(248,113,113,0.15)', color: '#f87171' }}>
                    {highCount} High
                  </span>
                )}
                {medCount > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24' }}>
                    {medCount} Medium
                  </span>
                )}
              </div>

              <div className="space-y-2">
                {visibleFlags.map(f => <FlagCard key={f.id} flag={f} />)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
