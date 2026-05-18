'use client';

import { useState, useEffect } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

let _cache: string[] | null = null;

export function useAvailableQuarters(): string[] {
  const [quarters, setQuarters] = useState<string[]>(_cache ?? []);

  useEffect(() => {
    if (_cache) return;
    fetch(`${API}/api/companies`)
      .then(r => r.json())
      .then(d => {
        const seen = new Set<string>();
        for (const c of d.companies ?? []) {
          for (const q of c.quarters ?? []) {
            if (q.status === 'ingested') seen.add(q.quarter);
          }
        }
        _cache = [...seen].sort();
        setQuarters(_cache!);
      })
      .catch(() => {});
  }, []);

  return quarters;
}
