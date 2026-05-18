'use client';

import { useState } from 'react';
import type { Citation } from './QueryInterface';

interface Props { citations: Citation[] }

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button onClick={copy}
      className="ml-auto shrink-0 text-xs px-2 py-0.5 rounded-md transition-colors"
      style={{ border: '1px solid rgba(255,255,255,0.1)', color: copied ? '#34d399' : 'rgba(255,255,255,0.35)' }}>
      {copied ? '✓ copied' : 'copy'}
    </button>
  );
}

export default function CitationList({ citations }: Props) {
  if (citations.length === 0) return null;
  return (
    <div className="glass rounded-2xl p-5">
      <p className="text-xs font-semibold uppercase tracking-widest text-amber-400 mb-4">
        Source Citations ({citations.length})
      </p>
      <div className="space-y-4">
        {citations.map((c, i) => (
          <div key={i} className="pl-4 space-y-1.5" style={{ borderLeft: '2px solid rgba(245,158,11,0.2)' }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono px-2 py-0.5 rounded-md text-amber-400"
                style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)' }}>
                {c.ticker}
              </span>
              <span className="text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>{c.quarter}</span>
              <span className="text-xs" style={{ color: 'rgba(255,255,255,0.2)' }}>·</span>
              <span className="text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>{c.speaker}</span>
              <CopyButton text={`[${c.ticker} ${c.quarter} — ${c.speaker}]\n"${c.text}"`} />
            </div>
            <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.7)' }}>
              &ldquo;{c.text}&rdquo;
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
