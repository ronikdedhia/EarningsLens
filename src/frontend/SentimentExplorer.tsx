'use client';

import { useState, useEffect } from 'react';
import SentimentChart from './SentimentChart';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface SentimentRow { quarter: string; sentiment: string; score: number }
interface TickerSentiment { ticker: string; history: SentimentRow[] }

export default function SentimentExplorer() {
  const [allData, setAllData] = useState<TickerSentiment[]>([]);
  const [active, setActive]   = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/api/companies`)
      .then(r => r.json())
      .then(async (d) => {
        const tickers: string[] = (d.companies ?? [])
          .filter((c: { quarters: { status: string }[] }) => c.quarters.some(q => q.status === 'ingested'))
          .map((c: { ticker: string }) => c.ticker);

        const results = await Promise.all(
          tickers.map(ticker =>
            fetch(`${API}/api/sentiment?ticker=${ticker}`)
              .then(r => r.json())
              .then(j => ({ ticker, history: j.history ?? [] }))
              .catch(() => ({ ticker, history: [] }))
          )
        );
        const withData = results.filter(r => r.history.length > 0);
        setAllData(withData);
        setActive(new Set(withData.map(r => r.ticker)));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const visible = allData.filter(d => active.has(d.ticker));

  function toggle(ticker: string) {
    setActive(prev => { const n = new Set(prev); n.has(ticker) ? n.delete(ticker) : n.add(ticker); return n; });
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>
      Loading sentiment data…
    </div>
  );

  if (allData.length === 0) return (
    <div className="text-center py-20 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>
      No sentiment data yet — ingest transcripts first.
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Ticker chips */}
      <div className="flex flex-wrap gap-2">
        {allData.map(({ ticker }) => {
          const on = active.has(ticker);
          return (
            <button key={ticker} onClick={() => toggle(ticker)}
              className={`px-3 py-1.5 text-xs rounded-full font-mono font-semibold transition-all duration-200 ${
                on
                  ? 'text-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.2)]'
                  : ''
              }`}
              style={on
                ? { background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)' }
                : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)' }
              }>
              {ticker}
            </button>
          );
        })}
        {active.size < allData.length && (
          <button onClick={() => setActive(new Set(allData.map(d => d.ticker)))}
            className="px-3 py-1.5 text-xs rounded-full transition-colors"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.3)' }}>
            Show all
          </button>
        )}
      </div>

      {visible.length === 0
        ? <div className="text-center py-12 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>No tickers selected.</div>
        : <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {visible.map(({ ticker, history }) => (
              <SentimentChart key={ticker} ticker={ticker} data={history} />
            ))}
          </div>
      }
    </div>
  );
}
