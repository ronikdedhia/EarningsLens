'use client';

import { useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Props { answer: string; queryLogId?: number }

export default function AnswerCard({ answer, queryLogId }: Props) {
  const [rated, setRated] = useState<1 | -1 | null>(null);

  async function rate(r: 1 | -1) {
    if (rated !== null || !queryLogId) return;
    setRated(r);
    fetch(`${API}/api/queries/${queryLogId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: r }),
    }).catch(() => {});
  }

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">Analysis</p>
        {queryLogId && (
          <div className="flex items-center gap-1">
            <span className="text-xs mr-1" style={{ color: 'rgba(255,255,255,0.25)' }}>Helpful?</span>
            {([1, -1] as const).map(r => (
              <button key={r} onClick={() => rate(r)} disabled={rated !== null}
                className={`px-2 py-1 rounded text-sm transition-colors disabled:cursor-default ${
                  rated === r ? (r === 1 ? 'text-emerald-400' : 'text-red-400') : 'opacity-40 hover:opacity-80'
                }`}>
                {r === 1 ? '👍' : '👎'}
              </button>
            ))}
            {rated !== null && (
              <span className="text-xs ml-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
                {rated === 1 ? 'Thanks!' : 'Noted'}
              </span>
            )}
          </div>
        )}
      </div>
      <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'rgba(255,255,255,0.82)' }}>
        {answer}
      </p>
    </div>
  );
}
