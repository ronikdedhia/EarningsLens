'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface QuarterStatus {
  quarter: string;
  fiscalYear: number;
  pdfUrl: string;
  ingestedAt: string | null;
  status: 'ingested' | 'pending' | 'missing';
}

interface CompanyStatus {
  ticker: string;
  name: string;
  sector: string;
  bseCode: string | null;
  quarters: QuarterStatus[];
}

interface Stats { companies: number; ingested: number; pending: number; sectors: number; aiInsights: number }

interface InsightRow { id: number; ticker: string; title: string; content: string; generatedAt: string }
interface QueryLogRow { id: number; query: string; answer: string; createdAt: string }

interface DrawerCache {
  insights: InsightRow[];
  queryLogs: QueryLogRow[];
}

const STATUS_BADGE: Record<string, { bg: string; color: string; dot: string }> = {
  ingested: { bg: 'rgba(16,185,129,0.1)',   color: '#34d399', dot: '#34d399' },
  pending:  { bg: 'rgba(245,158,11,0.1)',   color: '#fbbf24', dot: '#fbbf24' },
  missing:  { bg: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.25)', dot: 'rgba(255,255,255,0.2)' },
};

const SENTIMENT_STYLE: Record<string, { bg: string; color: string }> = {
  positive: { bg: 'rgba(16,185,129,0.15)',  color: '#34d399' },
  negative: { bg: 'rgba(239,68,68,0.15)',   color: '#f87171' },
  neutral:  { bg: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.4)' },
};

const INSIGHT_ICONS: Record<string, string> = {
  'Financial Performance':         '📊',
  'Management Guidance':           '🎯',
  'Key Risks & Concerns':          '⚠️',
  'Strategic Initiatives':         '🚀',
  'Management Tone & Confidence':  '🎙️',
};


function renderContent(text: string) {
  return text.split('\n').map((line, li) => {
    const parts = line.split(/\*\*(.+?)\*\*/g);
    return (
      <span key={li}>
        {parts.map((part, pi) =>
          pi % 2 === 1
            ? <strong key={pi} style={{ color: 'rgba(255,255,255,0.95)', fontWeight: 600 }}>{part}</strong>
            : part
        )}
        {li < text.split('\n').length - 1 && <br />}
      </span>
    );
  });
}

function InsightCard({ insight }: { insight: InsightRow }) {
  const [open, setOpen] = useState(false);
  const icon = INSIGHT_ICONS[insight.title] ?? '💡';
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors"
        style={{ background: open ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.02)' }}
      >
        <span className="flex items-center gap-2 text-sm font-medium" style={{ color: 'rgba(255,255,255,0.82)' }}>
          <span>{icon}</span>
          {insight.title}
        </span>
        <span className="text-xs ml-4" style={{ color: 'rgba(255,255,255,0.28)' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-4 py-3 text-sm leading-relaxed"
          style={{ background: 'rgba(255,255,255,0.03)', borderTop: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.68)' }}>
          {renderContent(insight.content)}
        </div>
      )}
    </div>
  );
}

const USELESS_PREFIXES = [
  'No relevant transcript excerpts found',
  'Unfortunately',
  'I cannot',
  'I don\'t have',
  'The provided transcript',
];

const INSUFFICIENT_PATTERNS = [
  'Context insufficient',
  'insufficient to provide',
  'insufficient context',
  'not enough context',
  'cannot provide a comprehensive',
  'transcript does not contain',
  'no information',
  'no data available',
];

function QueryLogCard({ log }: { log: QueryLogRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-start justify-between px-4 py-3 text-left gap-3 transition-colors"
        style={{ background: open ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.02)' }}
      >
        <span className="text-sm line-clamp-2" style={{ color: 'rgba(255,255,255,0.72)' }}>{log.query}</span>
        <span className="text-xs shrink-0" style={{ color: 'rgba(255,255,255,0.28)' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-4 py-3 text-sm leading-relaxed"
          style={{ background: 'rgba(255,255,255,0.03)', borderTop: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.6)' }}>
          {renderContent(log.answer)}
        </div>
      )}
    </div>
  );
}

function CompanyDrawer({
  ticker, name, bseCode, quarters,
  cached, onLoaded,
}: {
  ticker: string;
  name: string;
  bseCode: string | null;
  quarters: QuarterStatus[];
  cached: DrawerCache | undefined;
  onLoaded: (data: DrawerCache) => void;
}) {
  const [insights, setInsights]     = useState<InsightRow[]>(cached?.insights ?? []);
  const [queryLogs, setQueryLogs]   = useState<QueryLogRow[]>(cached?.queryLogs ?? []);
  const [generating, setGenerating] = useState(false);
  const [loaded, setLoaded]         = useState(!!cached);
  const [showAllLogs, setShowAllLogs] = useState(false);

  useEffect(() => {
    if (cached) return;
    fetch(`${API}/api/insights/${ticker}`)
      .then(r => r.json())
      .then(async (d) => {
        const logs = (d.queryLogs ?? []).filter(
          (q: QueryLogRow) => !USELESS_PREFIXES.some(p => q.answer.startsWith(p))
        );
        if ((d.insights ?? []).length > 0) {
          setInsights(d.insights);
          setQueryLogs(logs);
          onLoaded({ insights: d.insights, queryLogs: logs });
          setLoaded(true);
        } else {
          setGenerating(true);
          const gen = await fetch(`${API}/api/insights/generate/${ticker}`, { method: 'POST' });
          const gd  = await gen.json();
          const newInsights = gd.insights ?? [];
          setInsights(newInsights);
          setQueryLogs(logs);
          onLoaded({ insights: newInsights, queryLogs: logs });
          setGenerating(false);
          setLoaded(true);
        }
      })
      .catch(() => setLoaded(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  if (generating) {
    return (
      <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="flex items-center gap-2 text-sm text-amber-400">
          <span className="animate-spin inline-block">⟳</span>
          Generating insights for {name} — this takes ~30 seconds…
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="mt-4 pt-4 text-sm" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.28)' }}>
        Loading…
      </div>
    );
  }

  const visibleLogs = showAllLogs ? queryLogs : queryLogs.slice(0, 5);
  const usefulInsights = insights
    .filter(ins => !INSUFFICIENT_PATTERNS.some(p => ins.content.toLowerCase().includes(p.toLowerCase())))
    .filter((ins, idx, arr) => arr.findIndex(x => x.title === ins.title) === idx);

  return (
    <div className="mt-4 pt-4 space-y-4" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      {/* BSE code + quarter badges live here */}
      {(bseCode || quarters.length > 0) && (
        <div className="space-y-2">
          {bseCode && (
            <p className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>BSE: {bseCode}</p>
          )}
          {quarters.filter(q => q.status === 'ingested').length > 0 && (
            <div className="flex flex-wrap gap-2">
              {quarters.filter(q => q.status === 'ingested').map(q => {
                const b = STATUS_BADGE.ingested;
                return (
                  <span
                    key={q.quarter}
                    title={`Processed ${q.ingestedAt?.slice(0, 10)}`}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md"
                    style={{ background: b.bg, color: b.color, border: `1px solid ${b.dot}30` }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: b.dot }} />
                    {q.quarter}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {usefulInsights.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">AI Insights</p>
          <div className="space-y-1.5">
            {usefulInsights.map(ins => <InsightCard key={ins.id} insight={ins} />)}
          </div>
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'rgba(255,255,255,0.28)' }}>No insights available.</p>
      )}

      {queryLogs.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">Past Q&amp;A</p>
          <div className="space-y-1.5">
            {visibleLogs.map(log => <QueryLogCard key={log.id} log={log} />)}
          </div>
          {queryLogs.length > 5 && (
            <button
              onClick={e => { e.stopPropagation(); setShowAllLogs(s => !s); }}
              className="w-full text-center text-xs pt-1 transition-colors hover:text-amber-300"
              style={{ color: 'rgba(255,255,255,0.28)' }}
            >
              {showAllLogs ? 'Show less' : `Show all ${queryLogs.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function CompaniesPanel() {
  const [companies, setCompanies]   = useState<CompanyStatus[]>([]);
  const [stats, setStats]           = useState<Stats | null>(null);
  const [loading, setLoading]       = useState(true);
  const [expanded, setExpanded]     = useState<string | null>(null);
  const [filterTicker, setFilterTicker] = useState('');
  const [sentimentMap, setSentimentMap] = useState<Record<string, { sentiment: string; score: number }>>({});
  const insightCache   = useRef<Record<string, DrawerCache>>({});
  const loadedSentiment = useRef<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      const res  = await fetch(`${API}/api/companies`);
      const data = await res.json();
      setCompanies(data.companies ?? []);
      setStats(data.stats ?? null);
    } catch {
      // backend unreachable — show empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Fetch latest-quarter sentiment for each company (runs whenever companies list changes)
  useEffect(() => {
    companies.forEach(c => {
      if (loadedSentiment.current.has(c.ticker)) return;
      loadedSentiment.current.add(c.ticker);
      fetch(`${API}/api/sentiment?ticker=${c.ticker}`)
        .then(r => r.json())
        .then(d => {
          const history: { quarter: string; sentiment: string; score: number }[] = d.history ?? [];
          if (history.length > 0) {
            const latest = history[history.length - 1];
            setSentimentMap(prev => ({ ...prev, [c.ticker]: { sentiment: latest.sentiment, score: latest.score } }));
          }
        })
        .catch(() => {}); // backend unreachable — skip sentiment badges
    });
  }, [companies]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm" style={{ color: 'rgba(255,255,255,0.28)' }}>
        Loading companies…
      </div>
    );
  }

  const filtered = filterTicker
    ? companies.filter(c => c.ticker === filterTicker)
    : companies;

  const grouped = Object.entries(
    filtered.reduce((acc, c) => {
      (acc[c.sector] ??= []).push(c);
      return acc;
    }, {} as Record<string, CompanyStatus[]>)
  ).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Companies',   value: String(stats.companies),  color: 'rgba(255,255,255,0.9)', sub: 'NSE tracked' },
            { label: 'Transcripts', value: String(stats.ingested),   color: '#34d399',               sub: 'quarters ingested' },
            { label: 'Sectors',     value: String(stats.sectors),    color: '#a78bfa',               sub: 'industries covered' },
            { label: 'AI Insights', value: String(stats.aiInsights), color: '#f59e0b',               sub: 'generated analyses' },
          ].map(s => (
            <div key={s.label} className="glass rounded-2xl p-4 text-center">
              <div className="text-3xl font-bold" style={{ color: s.color }}>{s.value}</div>
              <div className="text-xs mt-1 font-medium uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.4)' }}>{s.label}</div>
              <div className="text-[10px] mt-0.5" style={{ color: 'rgba(255,255,255,0.2)' }}>{s.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Company filter dropdown + legend */}
      <div className="flex items-center gap-4">
        <select
          value={filterTicker}
          onChange={e => setFilterTicker(e.target.value)}
          className="flex-1 rounded-xl px-3 py-2 text-sm outline-none"
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: filterTicker ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.4)',
          }}
        >
          <option value="">All companies</option>
          {companies.map(c => (
            <option key={c.ticker} value={c.ticker} style={{ background: '#1a1a2e' }}>
              {c.ticker} — {c.name}
            </option>
          ))}
        </select>
        <span className="flex items-center gap-1.5 text-xs shrink-0" style={{ color: 'rgba(255,255,255,0.3)' }}>
          <span className="w-2 h-2 rounded-full" style={{ background: STATUS_BADGE.ingested.dot }} />
          Processed
        </span>
      </div>

      {/* Sector-grouped company cards */}
      <div className="space-y-8">
        {grouped.length === 0 && (
          <p className="text-sm text-center py-10" style={{ color: 'rgba(255,255,255,0.25)' }}>
            No companies found.
          </p>
        )}
        {grouped.map(([sector, sectorCompanies]) => (
          <div key={sector}>
            <h3 className="text-xs font-semibold uppercase tracking-widest mb-3 flex items-center gap-2"
              style={{ color: 'rgba(255,255,255,0.35)' }}>
              <span className="w-4 h-px" style={{ background: 'rgba(255,255,255,0.12)' }} />
              {sector}
              <span className="font-normal normal-case tracking-normal" style={{ color: 'rgba(255,255,255,0.45)' }}>
                {sectorCompanies.length} co.
              </span>
            </h3>
            <div className="grid gap-3">
              {sectorCompanies.map(company => {
                const isOpen    = expanded === company.ticker;
                const sentData  = sentimentMap[company.ticker];
                const sentStyle = sentData ? (SENTIMENT_STYLE[sentData.sentiment] ?? SENTIMENT_STYLE.neutral) : null;

                return (
                  <div
                    key={company.ticker}
                    className="glass rounded-2xl p-5 cursor-pointer transition-all duration-200"
                    style={isOpen
                      ? { border: '1px solid rgba(245,158,11,0.35)', boxShadow: '0 0 24px rgba(245,158,11,0.08)' }
                      : { border: '1px solid rgba(255,255,255,0.08)' }
                    }
                    onClick={() => setExpanded(isOpen ? null : company.ticker)}
                  >
                    {/* Header row */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-amber-400 font-semibold text-sm">{company.ticker}</span>
                          {sentStyle && (
                            <span
                              className="text-xs px-2 py-0.5 rounded-full capitalize"
                              style={{ background: sentStyle.bg, color: sentStyle.color, border: `1px solid ${sentStyle.color}22` }}
                            >
                              {sentData!.sentiment}
                            </span>
                          )}
                        </div>
                        <div className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.72)' }}>{company.name}</div>
                      </div>
                      <span className="text-sm shrink-0" style={{ color: 'rgba(255,255,255,0.3)' }}>{isOpen ? '▲' : '▼'}</span>
                    </div>

                    {company.quarters.length === 0 && (
                      <p className="text-xs mt-3" style={{ color: 'rgba(255,255,255,0.2)' }}>No quarters registered yet.</p>
                    )}

                    {isOpen && (
                      <div onClick={e => e.stopPropagation()}>
                        <CompanyDrawer
                          ticker={company.ticker}
                          name={company.name}
                          bseCode={company.bseCode}
                          quarters={company.quarters}
                          cached={insightCache.current[company.ticker]}
                          onLoaded={data => { insightCache.current[company.ticker] = data; }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
