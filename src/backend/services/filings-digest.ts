import { escapeHtml } from './telegram.service';

export interface DigestFailure {
  ticker: string;
  error:  string;
}

export interface DigestFiling {
  ticker:      string;
  title:       string;
  importance:  number;
  isImportant: boolean;
  insights:    { summary?: string } | null;
}

export interface DigestInput {
  targetDate:   string;
  companies:    number;           // companies attempted
  totalScraped: number;           // filings returned before dedup
  failures:     DigestFailure[];  // companies where every source failed
  newCount:     number;           // filings not seen before
  processed:    DigestFiling[];
  unclassified: Array<{ ticker: string; title: string }>;
}

export function truncateTitle(title: string, max = 100): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut) + '…';
}

function groupByTicker<T extends { ticker: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    if (!map.has(item.ticker)) map.set(item.ticker, []);
    map.get(item.ticker)!.push(item);
  }
  return map;
}

/**
 * Builds the daily Telegram digest as HTML message parts.
 *
 * The old "BSE returned 0 filings — possible API blip" fired whenever the total
 * was zero, which covered both "nobody filed" and "every request was blocked".
 * Since BSE's API started returning 403 to every request, it fired daily. Each
 * case now gets its own message, and fetch failures name the actual error.
 */
export function buildDigest(d: DigestInput): string[] {
  const header = `📋 <b>EarningsLens</b> — ${escapeHtml(d.targetDate)}`;

  if (d.companies === 0) {
    return [`${header}\nNo companies are tracked yet — nothing to scan.`];
  }

  const failureLine = d.failures.length
    ? `⚠️ Could not fetch filings for ${d.failures.length}/${d.companies} companies: ` +
      d.failures.slice(0, 8).map(f => `${escapeHtml(f.ticker)} (${escapeHtml(f.error)})`).join(', ') +
      (d.failures.length > 8 ? ', …' : '')
    : '';

  if (d.failures.length >= d.companies) {
    return [`${header}\n${failureLine}\nNo filings were checked today. If this repeats, the exchange is blocking this server's IP.`];
  }

  const parts: string[] = [];

  if (d.newCount === 0) {
    const status = d.totalScraped === 0
      ? `No filings in the last 24h across ${d.companies - d.failures.length} companies.`
      : `No new filings since the last run (${d.totalScraped} already seen).`;
    parts.push([header, status, failureLine].filter(Boolean).join('\n'));
  } else {
    const important = d.processed.filter(f => f.isImportant);

    if (!important.length) {
      const sections = [...groupByTicker(d.processed)].map(([ticker, filings]) =>
        `<b>${escapeHtml(ticker)}</b> (${filings.length})\n` +
        filings.map(f => `  · ${escapeHtml(truncateTitle(f.title))}`).join('\n'));
      const head = [header, `${d.processed.length} new filings saved, none flagged important`, failureLine]
        .filter(Boolean).join('\n');
      parts.push(sections.length ? `${head}\n\n${sections.join('\n\n')}` : head);
    } else {
      const sections = [...groupByTicker(important)].map(([ticker, filings]) => {
        const lines = filings.map(f => {
          const emoji = f.importance >= 5 ? '🔴' : f.importance >= 4 ? '🟡' : '🟢';
          const summary = f.insights?.summary ? `\n    <i>${escapeHtml(f.insights.summary.slice(0, 200))}</i>` : '';
          return `  ${emoji} ${escapeHtml(truncateTitle(f.title))}${summary}`;
        });
        return `<b>${escapeHtml(ticker)}</b> (${filings.length})\n${lines.join('\n')}`;
      });
      const CHUNK = 6; // tickers per message
      for (let i = 0; i < sections.length; i += CHUNK) {
        const head = i === 0
          ? [header, `${important.length} important of ${d.newCount} new filings`, failureLine].filter(Boolean).join('\n')
          : '📋 <i>(continued)</i>';
        parts.push(`${head}\n\n${sections.slice(i, i + CHUNK).join('\n\n')}`);
      }
    }
  }

  if (d.unclassified.length) {
    parts.push(
      `⚠️ ${d.unclassified.length} filing(s) could not be classified (Groq error) and were not saved; re-run to retry:\n` +
      d.unclassified.slice(0, 10).map(f => `  · <b>${escapeHtml(f.ticker)}</b> ${escapeHtml(truncateTitle(f.title))}`).join('\n'),
    );
  }
  return parts;
}
