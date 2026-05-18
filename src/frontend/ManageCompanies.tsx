'use client';

import { useState } from 'react';
import { useUser } from '@clerk/nextjs';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface SearchResult  { ticker: string; name: string }
interface CompanyInfo   { ticker: string; name: string; sector: string; bseCode: string | null; exists: boolean }
interface DiscoverResult { quarter: string; pdfUrl: string | null; status: string }
interface ImportData    { ticker: string; name: string; sector: string; results: DiscoverResult[] }

type Stage = 'idle' | 'searching' | 'picking' | 'looking' | 'confirming' | 'importing' | 'done' | 'blocked' | 'error';

function statusColor(s: string): string {
  if (s.startsWith('ingested'))  return '#34d399';
  if (s.startsWith('already'))   return '#34d399';
  if (s.startsWith('queued'))    return '#fbbf24';
  if (s.startsWith('not_found')) return 'rgba(255,255,255,0.25)';
  return '#f87171';
}

export default function ManageCompanies() {
  const { user }                = useUser();
  const [input, setInput]       = useState('');
  const [stage, setStage]       = useState<Stage>('idle');
  const [error, setError]       = useState('');
  const [results, setResults]   = useState<SearchResult[]>([]);
  const [company, setCompany]   = useState<CompanyInfo | null>(null);
  const [imported, setImported] = useState<ImportData | null>(null);

  function reset() { setStage('idle'); setError(''); setResults([]); setCompany(null); setImported(null); }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q) return;

    setStage('searching'); setError(''); setResults([]); setCompany(null); setImported(null);

    try {
      const res  = await fetch(`${API}/api/companies/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();

      if (!res.ok) {
        setStage('error');
        setError(data.error ?? 'Search failed. Try again.');
        return;
      }

      if (!Array.isArray(data) || !data.length) {
        setStage('error');
        setError(`No companies found for "${q}". Try a different name or the exact NSE ticker.`);
        return;
      }

      if (data.length === 1) {
        // Single match — skip the picker, go straight to lookup
        await lookupTicker(data[0].ticker);
        return;
      }

      setResults(data);
      setStage('picking');
    } catch {
      setStage('error');
      setError('Could not reach the server.');
    }
  }

  async function lookupTicker(ticker: string) {
    setStage('looking');
    try {
      const res  = await fetch(`${API}/api/companies/${ticker}`);
      const data = await res.json();

      if (!res.ok) { setStage('error'); setError(data.error ?? 'Lookup failed.'); return; }
      if (data.exists) { setStage('blocked'); setCompany(data); return; }

      setCompany(data);
      setStage('confirming');
    } catch {
      setStage('error');
      setError('Could not reach the server.');
    }
  }

  async function handleConfirm() {
    if (!company) return;
    setStage('importing');

    try {
      const res  = await fetch(`${API}/api/companies/add-and-discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: company.ticker, userId: user?.id }),
      });
      const data = await res.json();

      if (res.status === 409) { setStage('blocked'); return; }
      if (res.status === 402) { setStage('error'); setError(data.error ?? 'Company limit reached.'); return; }
      if (!res.ok) { setStage('error'); setError(data.error ?? 'Import failed.'); return; }

      setImported(data);
      setStage('done');
      setInput('');
    } catch {
      setStage('error');
      setError('Could not reach the server.');
    }
  }

  const busy = stage === 'searching' || stage === 'looking' || stage === 'importing';

  return (
    <div className="space-y-6">
      <div className="glass rounded-2xl p-6 space-y-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">Add to Coverage Universe</p>
          <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
            Enter a company name or NSE ticker to import available earnings call transcripts and enable AI-powered research.
          </p>
        </div>

        {/* Search input — visible during idle / searching / error / picking */}
        {(stage === 'idle' || stage === 'searching' || stage === 'error' || stage === 'picking') && (
          <form onSubmit={handleSearch} className="flex gap-3">
            <input
              value={input}
              onChange={e => { setInput(e.target.value); if (stage === 'error') { setStage('idle'); setError(''); } }}
              placeholder="e.g. Kotak Bank or KOTAKBANK"
              disabled={stage === 'searching'}
              className="flex-1 glass-input rounded-xl px-4 py-2.5 text-sm focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="px-5 py-2.5 bg-amber-400 text-gray-900 font-semibold text-sm rounded-xl
                         hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed transition-all
                         shadow-[0_0_20px_rgba(245,158,11,0.3)]"
            >
              {stage === 'searching' ? 'Searching…' : 'Search'}
            </button>
          </form>
        )}

        {/* Error */}
        {stage === 'error' && (
          <div className="rounded-xl px-4 py-3 text-sm text-red-300"
            style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
            {error}
          </div>
        )}

        {/* Multiple results — let the user pick */}
        {stage === 'picking' && (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
              {results.length} companies found — select the one you want to add:
            </p>
            <div className="space-y-1.5">
              {results.map(r => (
                <button
                  key={r.ticker}
                  onClick={() => lookupTicker(r.ticker)}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <span className="font-mono text-amber-400 text-sm font-semibold w-28 shrink-0">{r.ticker}</span>
                  <span className="text-sm" style={{ color: 'rgba(255,255,255,0.75)' }}>{r.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Looking up selected ticker */}
        {stage === 'looking' && (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>
            <span className="animate-spin inline-block text-amber-400">⟳</span>
            Fetching company details…
          </div>
        )}

        {/* Already in coverage */}
        {stage === 'blocked' && company && (
          <div className="space-y-3">
            <div className="rounded-xl px-4 py-3 text-sm"
              style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', color: '#fbbf24' }}>
              <strong>{company.ticker}</strong> — {company.name} is already in your coverage universe. Use the Research tab to query it.
            </div>
            <button onClick={reset} className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>Search again</button>
          </div>
        )}

        {/* Confirmation */}
        {stage === 'confirming' && company && (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>Is this the company you want to add?</p>
            <div className="rounded-xl p-4 space-y-3"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-base font-semibold" style={{ color: 'rgba(255,255,255,0.9)' }}>{company.name}</p>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full shrink-0"
                  style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  {company.sector}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <div>
                  <p className="text-xs uppercase tracking-widest mb-0.5" style={{ color: 'rgba(255,255,255,0.25)' }}>NSE Ticker</p>
                  <p className="font-mono text-amber-400 font-semibold text-sm">{company.ticker}</p>
                </div>
<div>
                  <p className="text-xs uppercase tracking-widest mb-0.5" style={{ color: 'rgba(255,255,255,0.25)' }}>Status</p>
                  <p className="text-sm" style={{ color: '#34d399' }}>New — not yet in coverage</p>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleConfirm}
                className="px-5 py-2 bg-amber-400 text-gray-900 font-semibold text-sm rounded-xl
                           hover:bg-amber-300 transition-all shadow-[0_0_20px_rgba(245,158,11,0.3)]"
              >
                Yes, import transcripts
              </button>
              <button
                onClick={reset}
                className="px-4 py-2 text-sm rounded-xl transition-all"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.45)' }}
              >
                No, search again
              </button>
            </div>
          </div>
        )}

        {/* Importing */}
        {stage === 'importing' && (
          <div className="flex items-center gap-2 text-sm text-amber-400">
            <span className="animate-spin inline-block">⟳</span>
            Fetching and importing earnings call transcripts — this may take ~30s…
          </div>
        )}

        {/* Done */}
        {stage === 'done' && imported && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-mono text-amber-400 font-semibold text-sm">{imported.ticker}</span>
              <span className="text-sm" style={{ color: 'rgba(255,255,255,0.65)' }}>{imported.name}</span>
              <span className="text-xs px-2 py-0.5 rounded-full ml-auto"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {imported.sector}
              </span>
            </div>
            <div className="space-y-1.5 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-xs font-semibold uppercase tracking-widest text-amber-400 mb-2">Transcript Import Results</p>
              {imported.results.length === 0 && (
                <p className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>No earnings call transcripts found for recent quarters.</p>
              )}
              {imported.results.map(r => (
                <div key={r.quarter} className="flex items-center justify-between text-xs">
                  <span className="font-mono" style={{ color: 'rgba(255,255,255,0.6)' }}>{r.quarter}</span>
                  <span style={{ color: statusColor(r.status) }}>{r.status}</span>
                </div>
              ))}
            </div>
            <button onClick={reset} className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>
              Add another company
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
