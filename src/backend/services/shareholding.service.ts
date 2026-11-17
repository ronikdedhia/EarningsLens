import { xbrlFacts, num } from '../utils/xbrl';
import { db, listCompanies } from './turso.service';
import { escapeHtml } from './telegram.service';
import { nseGet, nseArchiveText, parseNseDateTime, describeFetchError } from './nse.service';

// Quarterly shareholding pattern from the SHP XBRL each company files with NSE.
// Context ids name the category ("InstitutionsForeign_ContextI"); named holders
// at or above 1% have their name in D_<Category>_ContextN and their shares in
// <Category>_ContextN.

export interface NamedHolder {
  name:     string;
  category: 'MF' | 'FPI' | 'Insurance' | 'AIF' | 'Bank' | 'Other institution';
  pct:      number;   // 0–100
}

export interface ShareholdingRow {
  ticker:       string;
  periodEnd:    string;
  promoter:     number | null;
  fii:          number | null;
  dii:          number | null;
  mf:           number | null;
  publicPct:    number | null;
  totalShares:  number | null;
  shareholders: number | null;
  holders:      NamedHolder[];
  filedAt:      string;
  recordId:     string;
}

const INSTITUTION_CONTEXTS: Array<[RegExp, NamedHolder['category']]> = [
  [/^MutualFundsOrUTI_Context\d+$/, 'MF'],
  [/^InstitutionsForeignPortfolioInvestorCategory(One|Two)_Context\d+$/, 'FPI'],
  [/^ForeignPortfolioInvestor.*_Context\d+$/, 'FPI'],
  [/^InsuranceCompanies_Context\d+$/, 'Insurance'],
  [/^AlternativeInvestmentFunds_Context\d+$/, 'AIF'],
  [/^Banks_Context\d+$/, 'Bank'],
  [/^(ProvidentFundsOrPensionFunds|SovereignWealthFunds|OtherFinancialInstitutions|NBFCsRegisteredWithRBI)_Context\d+$/, 'Other institution'],
];

const pct = (v: string | undefined) => {
  const n = num(v);
  return n == null ? null : Math.round(n * 100 * 10000) / 10000;   // fraction → percent
};

export function parseShareholdingXbrl(xml: string): Omit<ShareholdingRow, 'ticker' | 'filedAt' | 'recordId' | 'periodEnd'> {
  const f = xbrlFacts(xml);
  const at = (ctx: string) => f[ctx] ?? {};
  const holders: NamedHolder[] = [];
  for (const ctx of Object.keys(f)) {
    const cat = INSTITUTION_CONTEXTS.find(([re]) => re.test(ctx))?.[1];
    if (!cat) continue;
    const name = at(`D_${ctx}`).NameOfTheShareholder?.replace(/\s+/g, ' ').trim();
    const p = pct(at(ctx).ShareholdingAsAPercentageOfTotalNumberOfShares);
    if (name && p != null) holders.push({ name, category: cat, pct: p });
  }
  const total = at('ShareholdingPattern_ContextI');
  return {
    promoter:     pct(at('ShareholdingOfPromoterAndPromoterGroup_ContextI').ShareholdingAsAPercentageOfTotalNumberOfShares),
    fii:          pct(at('InstitutionsForeign_ContextI').ShareholdingAsAPercentageOfTotalNumberOfShares),
    dii:          pct(at('InstitutionsDomestic_ContextI').ShareholdingAsAPercentageOfTotalNumberOfShares),
    mf:           pct(at('MutualFundsOrUTI_ContextI').ShareholdingAsAPercentageOfTotalNumberOfShares) ?? 0,
    publicPct:    pct(at('PublicShareholding_ContextI').ShareholdingAsAPercentageOfTotalNumberOfShares),
    totalShares:  num(total.NumberOfShares),
    shareholders: num(total.NumberOfShareholders),
    holders:      holders.sort((a, b) => b.pct - a.pct),
  };
}

// ── Changes (pure) ────────────────────────────────────────────────────────────

export interface HoldingChange {
  field:  'promoter' | 'fii' | 'dii' | 'mf' | 'publicPct' | 'shareholders';
  before: number;
  after:  number;
  delta:  number;
}

export interface HoldingFlags {
  changes:  HoldingChange[];
  entered:  NamedHolder[];   // named institution new at ≥1%
  exited:   NamedHolder[];   // named last quarter, gone (sold or fell below 1%)
  alerts:   string[];        // short human lines for the notable moves
}

const THRESHOLDS = { promoter: 0.5, fii: 1, dii: 1, mf: 0.5 } as const;

export function compareHoldings(prev: ShareholdingRow | null, cur: ShareholdingRow): HoldingFlags {
  const changes: HoldingChange[] = [];
  const alerts: string[] = [];
  if (!prev) return { changes, entered: [], exited: [], alerts };

  for (const field of ['promoter', 'fii', 'dii', 'mf', 'publicPct', 'shareholders'] as const) {
    const a = prev[field], b = cur[field];
    if (a == null || b == null) continue;
    changes.push({ field, before: a, after: b, delta: b - a });
  }
  const label: Record<string, string> = { promoter: 'Promoter', fii: 'FII', dii: 'DII', mf: 'Mutual funds' };
  for (const c of changes) {
    const t = THRESHOLDS[c.field as keyof typeof THRESHOLDS];
    if (t != null && Math.abs(c.delta) >= t) {
      alerts.push(`${label[c.field]} ${c.delta > 0 ? 'up' : 'down'} ${Math.abs(c.delta).toFixed(2)} pp to ${c.after.toFixed(2)}%`);
    }
  }
  const shareholders = changes.find(c => c.field === 'shareholders');
  if (shareholders && shareholders.before > 0 && Math.abs(shareholders.delta / shareholders.before) >= 0.15) {
    alerts.push(`Shareholder count ${shareholders.delta > 0 ? 'up' : 'down'} ${Math.abs((shareholders.delta / shareholders.before) * 100).toFixed(0)}% to ${shareholders.after.toLocaleString('en-IN')}`);
  }

  const key = (h: NamedHolder) => h.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const before = new Map(prev.holders.map(h => [key(h), h]));
  const after = new Map(cur.holders.map(h => [key(h), h]));
  const entered = cur.holders.filter(h => !before.has(key(h)));
  const exited = prev.holders.filter(h => !after.has(key(h)));
  for (const h of entered) alerts.push(`New ${h.category}: ${h.name} at ${h.pct.toFixed(2)}%`);
  for (const h of exited) alerts.push(`${h.category} gone from the ≥1% list: ${h.name} (was ${h.pct.toFixed(2)}%)`);
  return { changes, entered, exited, alerts };
}

export function formatHoldingsMessage(ticker: string, cur: ShareholdingRow, flags: HoldingFlags): string {
  const d = (f: HoldingChange['field']) => {
    const c = flags.changes.find(x => x.field === f);
    return c ? ` (${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(2)})` : '';
  };
  const v = (n: number | null) => (n == null ? 'n/a' : `${n.toFixed(2)}%`);
  const lines = [
    `🏦 <b>${escapeHtml(ticker)}</b> shareholding ${escapeHtml(cur.periodEnd)}`,
    `  Promoter ${v(cur.promoter)}${d('promoter')} · FII ${v(cur.fii)}${d('fii')} · DII ${v(cur.dii)}${d('dii')} · MF ${v(cur.mf)}${d('mf')}`,
  ];
  if (cur.shareholders != null) lines.push(`  Shareholders ${cur.shareholders.toLocaleString('en-IN')}`);
  if (flags.alerts.length) lines.push(...flags.alerts.map(a => `  ⚠️ ${escapeHtml(a)}`));
  return lines.join('\n');
}

// ── Store ─────────────────────────────────────────────────────────────────────

export async function saveShareholding(r: ShareholdingRow): Promise<void> {
  await db().execute({
    sql: `INSERT INTO shareholding (ticker, period_end, promoter, fii, dii, mf, public_pct, total_shares, shareholders, holders, filed_at, record_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (ticker, period_end) DO UPDATE SET
            promoter = excluded.promoter, fii = excluded.fii, dii = excluded.dii, mf = excluded.mf,
            public_pct = excluded.public_pct, total_shares = excluded.total_shares,
            shareholders = excluded.shareholders, holders = excluded.holders,
            filed_at = excluded.filed_at, record_id = excluded.record_id`,
    args: [r.ticker, r.periodEnd, r.promoter, r.fii, r.dii, r.mf, r.publicPct, r.totalShares, r.shareholders,
      JSON.stringify(r.holders), r.filedAt, r.recordId],
  });
}

export async function listShareholding(ticker: string): Promise<ShareholdingRow[]> {
  const { rows } = await db().execute({
    sql: `SELECT * FROM shareholding WHERE ticker = ? ORDER BY period_end`, args: [ticker],
  });
  const n = (v: unknown) => (v == null ? null : Number(v));
  return rows.map(r => ({
    ticker: String(r.ticker), periodEnd: String(r.period_end), promoter: n(r.promoter), fii: n(r.fii),
    dii: n(r.dii), mf: n(r.mf), publicPct: n(r.public_pct), totalShares: n(r.total_shares),
    shareholders: n(r.shareholders), holders: JSON.parse(String(r.holders ?? '[]')),
    filedAt: String(r.filed_at ?? ''), recordId: String(r.record_id ?? ''),
  }));
}

// ── Sync ──────────────────────────────────────────────────────────────────────

interface MasterRow { date?: string; recordId?: string; xbrl?: string; broadcastDate?: string; submissionDate?: string }

/** Latest filing per quarter (revisions get a higher recordId). */
export function latestPerQuarter(rows: MasterRow[]): Array<{ periodEnd: string; recordId: string; xbrl: string; filedAt: string }> {
  const best = new Map<string, { periodEnd: string; recordId: string; xbrl: string; filedAt: string }>();
  for (const r of rows) {
    const periodEnd = parseNseDateTime(r.date)?.date;
    if (!periodEnd || !/\.xml$/i.test(r.xbrl ?? '')) continue;
    const filed = parseNseDateTime(r.broadcastDate) ?? parseNseDateTime(r.submissionDate);
    const cand = { periodEnd, recordId: String(r.recordId ?? ''), xbrl: r.xbrl!, filedAt: filed?.date ?? '' };
    const cur = best.get(periodEnd);
    if (!cur || Number(cand.recordId) > Number(cur.recordId)) best.set(periodEnd, cand);
  }
  return [...best.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

export async function syncShareholding(opts: { quarters?: number; tickers?: string[]; announce?: boolean } = {}): Promise<{ stored: number; messages: string[]; failures: string[] }> {
  const tickers = opts.tickers ?? (await listCompanies()).map(c => c.ticker);
  const messages: string[] = [];
  const failures: string[] = [];
  let stored = 0;
  for (const ticker of tickers) {
    try {
      const master = await nseGet<MasterRow[]>('corporate-share-holdings-master', { index: 'equities', symbol: ticker });
      const filings = latestPerQuarter(Array.isArray(master) ? master : []).slice(-(opts.quarters ?? 2));
      const existing = new Map((await listShareholding(ticker)).map(r => [r.periodEnd, r]));
      for (const f of filings) {
        if (existing.get(f.periodEnd)?.recordId === f.recordId) continue;
        const parsed = parseShareholdingXbrl(await nseArchiveText(f.xbrl));
        const row: ShareholdingRow = { ticker, periodEnd: f.periodEnd, filedAt: f.filedAt, recordId: f.recordId, ...parsed };
        await saveShareholding(row);
        stored++;
        const prev = [...existing.values()].filter(r => r.periodEnd < f.periodEnd).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0] ?? null;
        if (opts.announce !== false && prev) messages.push(formatHoldingsMessage(ticker, row, compareHoldings(prev, row)));
        existing.set(f.periodEnd, row);
      }
    } catch (err) {
      failures.push(`${ticker}: ${describeFetchError(err)}`);
    }
  }
  return { stored, messages, failures };
}
