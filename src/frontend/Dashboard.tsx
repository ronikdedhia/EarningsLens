'use client';

import { useState } from 'react';
import CompaniesPanel from './CompaniesPanel';
import QueryInterface from './QueryInterface';
import SentimentExplorer from './SentimentExplorer';
import KeywordTracker from './KeywordTracker';
import ManageCompanies from './ManageCompanies';
import ManagementQuality from './ManagementQuality';

type Tab = 'overview' | 'research' | 'sentiment' | 'keywords' | 'pipeline' | 'management';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'overview',    label: 'Overview',    icon: '▦' },
  { id: 'research',    label: 'Research',    icon: '⌕' },
  { id: 'sentiment',   label: 'Sentiment',   icon: '↗' },
  { id: 'keywords',    label: 'Keywords',    icon: '⌇' },
  { id: 'pipeline',    label: 'Coverage',    icon: '⊕' },
  { id: 'management',  label: 'Management',  icon: '⬡' },
];

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div className="space-y-6">
      <nav className="glass rounded-2xl p-1.5 flex gap-1 w-fit flex-wrap">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl transition-all duration-200 ${
              tab === t.id
                ? 'bg-amber-400/15 text-amber-400 border border-amber-400/25 shadow-[0_0_16px_rgba(245,158,11,0.15)]'
                : 'text-white/40 hover:text-white/70 hover:bg-white/5'
            }`}
          >
            <span className="text-base leading-none">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview'  && <CompaniesPanel />}
      {tab === 'research'  && <QueryInterface />}
      {tab === 'sentiment' && <SentimentExplorer />}
      {tab === 'keywords'  && <KeywordTracker />}
      {tab === 'pipeline'   && <ManageCompanies />}
      {tab === 'management' && <ManagementQuality />}
    </div>
  );
}
