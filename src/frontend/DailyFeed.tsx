'use client';

import { useState, useEffect, useCallback } from 'react';

interface FilingInsights {
  summary:    string;
  keyPoints:  string[];
  sentiment:  'positive' | 'negative' | 'neutral';
  actionable: boolean;
  watchFor:   string;
}

interface DailyFiling {
  id:          number;
  ticker:      string;
  filingDate:  string;
  category:    string;
  title:       string;
  pdfUrl:      string;
  importance:  number;
  isImportant: boolean;
  filingCat:   string;
  insights:    FilingInsights | null;
  sentiment:   string;
  createdAt:   string;
}

const CATEGORY_TABS = [
  { key: 'all',              label: 'All' },
  { key: 'earnings',         label: 'Earnings' },
  { key: 'board',            label: 'Board' },
  { key: 'investor_meet',    label: 'Investor Meet' },
  { key: 'press_release',    label: 'Press Release' },
  { key: 'management_change',label: 'Management' },
  { key: 'acquisition',      label: 'Acquisition' },
  { key: 'regulatory',       label: 'Regulatory' },
];

const SENTIMENT_COLOR: Record<string, string> = {
  positive: 'text-emerald-400',
  negative: 'text-red-400',
  neutral:  'text-slate-400',
};

const IMPORTANCE_BADGE: Record<number, { label: string; color: string }> = {
  5: { label: 'Critical',  color: 'bg-red-500/20 text-red-400 border border-red-500/30' },
  4: { label: 'High',      color: 'bg-orange-500/20 text-orange-400 border border-orange-500/30' },
  3: { label: 'Medium',    color: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' },
  2: { label: 'Low',       color: 'bg-slate-500/20 text-slate-400 border border-slate-500/30' },
  1: { label: 'Minimal',   color: 'bg-slate-700/20 text-slate-500 border border-slate-700/30' },
};

function FilingCard({ filing }: { filing: DailyFiling }) {
  const [expanded, setExpanded] = useState(false);
  const badge = IMPORTANCE_BADGE[filing.importance] ?? IMPORTANCE_BADGE[1];

  return (
    <div className={`rounded-xl border transition-all ${
      filing.isImportant
        ? 'border-slate-600 bg-slate-800/60'
        : 'border-slate-700/50 bg-slate-800/30 opacity-70'
    }`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full text-left p-4"
      >
        <div className="flex items-start gap-3">
          <div className="flex flex-col gap-1.5 flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-cyan-400 bg-cyan-400/10 border border-cyan-400/20 px-2 py-0.5 rounded">
                {filing.ticker}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded ${badge.color}`}>
                {badge.label}
              </span>
              {filing.insights?.actionable && (
                <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30">
                  Action Required
                </span>
              )}
              <span className="text-xs text-slate-500">{filing.category}</span>
            </div>
            <p className="text-sm text-slate-200 font-medium leading-snug">
              {filing.title}
            </p>
            {filing.insights?.summary && (
              <p className={`text-xs leading-relaxed ${SENTIMENT_COLOR[filing.sentiment] ?? 'text-slate-400'}`}>
                {filing.insights.summary}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className="text-xs text-slate-500">{filing.filingDate}</span>
            <span className="text-slate-500 text-sm">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>
      </button>

      {expanded && filing.insights && (
        <div className="border-t border-slate-700/50 px-4 pb-4 pt-3 space-y-3">
          {filing.insights.keyPoints.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Key Points</p>
              <ul className="space-y-1">
                {filing.insights.keyPoints.map((pt, i) => (
                  <li key={i} className="text-xs text-slate-300 flex gap-2">
                    <span className="text-cyan-500 shrink-0">•</span>
                    <span>{pt}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {filing.insights.watchFor && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Watch For</p>
              <p className="text-xs text-amber-300/80">{filing.insights.watchFor}</p>
            </div>
          )}
          <a
            href={filing.pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs text-cyan-400 hover:text-cyan-300 underline"
            onClick={e => e.stopPropagation()}
          >
            View PDF →
          </a>
        </div>
      )}
    </div>
  );
}

export default function DailyFeed() {
  const [filings, setFilings]       = useState<DailyFiling[]>([]);
  const [loading, setLoading]       = useState(true);
  const [activeTab, setActiveTab]   = useState('all');
  const [importantOnly, setImportantOnly] = useState(false);
  const [selectedDate, setSelectedDate]   = useState('');
  const [selectedTicker, setSelectedTicker] = useState('');
  const [latestDate, setLatestDate] = useState('');

  const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedDate)   params.set('date',         selectedDate);
      if (selectedTicker) params.set('ticker',        selectedTicker.toUpperCase());
      if (importantOnly)  params.set('importantOnly', 'true');
      params.set('limit', '200');

      const res  = await fetch(`${API}/api/daily-filings?${params}`);
      const data = await res.json();
      setFilings(data.filings ?? []);
    } finally {
      setLoading(false);
    }
  }, [API, selectedDate, selectedTicker, importantOnly]);

  useEffect(() => {
    fetch(`${API}/api/daily-filings/latest-date`)
      .then(r => r.json())
      .then(d => {
        if (d.date) setLatestDate(d.date);
      })
      .catch(() => {});
  }, [API]);

  useEffect(() => { load(); }, [load]);

  const visible = activeTab === 'all'
    ? filings
    : filings.filter(f => f.filingCat === activeTab);

  const importantCount = filings.filter(f => f.isImportant).length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Daily Feed</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            BSE filings for tracked companies · last scraped{' '}
            <span className="text-slate-300">{latestDate || '—'}</span>
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="text-xs bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-slate-200"
          />
          <input
            type="text"
            value={selectedTicker}
            onChange={e => setSelectedTicker(e.target.value)}
            placeholder="Filter by ticker"
            className="text-xs bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-slate-200 w-32"
          />
          <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={importantOnly}
              onChange={e => setImportantOnly(e.target.checked)}
              className="accent-cyan-500"
            />
            Important only
          </label>
        </div>
      </div>

      {/* Stats bar */}
      {!loading && filings.length > 0 && (
        <div className="flex gap-4 text-xs text-slate-400">
          <span><span className="text-white font-semibold">{filings.length}</span> total filings</span>
          <span><span className="text-amber-400 font-semibold">{importantCount}</span> important</span>
        </div>
      )}

      {/* Category tabs */}
      <div className="flex gap-1 flex-wrap border-b border-slate-700 pb-0">
        {CATEGORY_TABS.map(tab => {
          const count = tab.key === 'all'
            ? filings.length
            : filings.filter(f => f.filingCat === tab.key).length;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`text-xs px-3 py-1.5 rounded-t-lg border border-b-0 transition-colors ${
                activeTab === tab.key
                  ? 'border-slate-600 bg-slate-800 text-white'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {tab.label}
              {count > 0 && (
                <span className="ml-1.5 text-[10px] text-slate-500">({count})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex justify-center py-12 text-slate-400 text-sm">Loading filings…</div>
      ) : visible.length === 0 ? (
        <div className="text-center py-12 text-slate-500 text-sm">
          No filings found.{' '}
          {!selectedDate && 'Select a date or wait for today’s 6 PM IST scrape.'}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(f => <FilingCard key={f.id} filing={f} />)}
        </div>
      )}
    </div>
  );
}
