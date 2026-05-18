'use client';

import { useState, useEffect } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

let _cache: string[] | null = null;

export function useCompanyTickers(): string[] {
  const [tickers, setTickers] = useState<string[]>(_cache ?? []);

  useEffect(() => {
    if (_cache) return;
    fetch(`${API}/api/companies`)
      .then(r => r.json())
      .then(d => {
        _cache = (d.companies ?? []).map((c: { ticker: string }) => c.ticker);
        setTickers(_cache!);
      })
      .catch(() => {});
  }, []);

  return tickers;
}
