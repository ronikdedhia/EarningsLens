import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, type DigestInput } from '../src/backend/services/filings-digest';
import { parseNseAnnouncements, nseDate, istDate, parseNseDate } from '../src/backend/services/nse.service';
import { isNseTranscript } from '../src/backend/services/concall-discovery.service';

// Shape copied from a real response (WOCKPHARMA, 2026-11-09)
const NSE_SAMPLE = [
  {
    an_dt: '09-Nov-2026 17:58:09',
    attchmntFile: 'https://nsearchives.nseindia.in/corporate/WOCKPHARMA_09112026175423_VKJTenurecompletionsd.pdf',
    attchmntText: 'Wockhardt Limited has informed the Exchange regarding Cessation of  Vinesh Kumar Jairath as Non- Executive Independent Director of the company w.e.f. November 09, 2026.',
    desc: 'Cessation',
    sort_date: '2026-11-09 17:58:09',
    symbol: 'WOCKPHARMA',
  },
  { an_dt: '08-Nov-2026 10:00:00', attchmntFile: '-', attchmntText: 'no attachment', desc: 'Updates', symbol: 'WOCKPHARMA' },
  { an_dt: '07-Nov-2026 10:00:00', attchmntFile: 'https://nsearchives.nseindia.in/corporate/x.zip', desc: 'XBRL', symbol: 'WOCKPHARMA' },
];

test('parseNseAnnouncements keeps PDF filings and normalises fields', () => {
  const rows = parseNseAnnouncements(NSE_SAMPLE, 'WOCKPHARMA');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'Cessation');
  assert.equal(rows[0].filingDate, '2026-11-09');
  assert.ok(!rows[0].text.includes('  '), 'whitespace collapsed');
});

test('parseNseAnnouncements treats a non-array (block page, error object) as a failure', () => {
  assert.throws(() => parseNseAnnouncements('<html>Access Denied</html>', 'X'));
  assert.throws(() => parseNseAnnouncements({ error: 'x' }, 'X'));
});

test('NSE dates are computed in India time, not server time', () => {
  // 20:00 UTC on the 15th is already the 16th in India
  assert.equal(nseDate(new Date('2026-11-15T20:00:00Z')), '16-11-2026');
  assert.equal(istDate(new Date('2026-11-15T17:00:00Z')), '2026-11-15');
  assert.equal(parseNseDate({ an_dt: '09-Nov-2026 17:58:09' }), '2026-11-09');
});

test('isNseTranscript matches both category styles seen on NSE', () => {
  assert.equal(isNseTranscript({
    category: 'Analysts/Institutional Investor Meet/Con. Call Updates',
    text: 'Shakti Pumps (India) Limited has informed the Exchange about Transcript of the Earnings Conference Call held on',
  }), true);
  assert.equal(isNseTranscript({ category: 'Updates', text: "Infosys Limited has informed the Exchange regarding 'Earnings Call Transcript'." }), true);
  assert.equal(isNseTranscript({ category: 'Analysts/Institutional Investor Meet/Con. Call Updates', text: 'Schedule of analyst meet' }), false);
  assert.equal(isNseTranscript({ category: 'Shareholders meeting', text: 'Transcript of the AGM call' }), false);
});

const base: DigestInput = {
  targetDate: '2026-11-16', companies: 8, totalScraped: 0, failures: [], newCount: 0, processed: [], unclassified: [],
};

test('digest: every company failed → names the error, no "API blip"', () => {
  const failures = Array.from({ length: 8 }, (_, i) => ({ ticker: `T${i}`, error: 'NSE HTTP 403; BSE HTTP 403' }));
  const [msg, ...rest] = buildDigest({ ...base, failures });
  assert.equal(rest.length, 0);
  assert.match(msg, /Could not fetch filings for 8\/8 companies/);
  assert.match(msg, /HTTP 403/);
  assert.doesNotMatch(msg, /blip/i);
});

test('digest: nothing filed and nothing failed → says so plainly', () => {
  const [msg] = buildDigest(base);
  assert.match(msg, /No filings in the last 24h across 8 companies/);
  assert.doesNotMatch(msg, /blip|⚠/i);
});

test('digest: all already seen → one short line, not a repeat of every title', () => {
  const [msg] = buildDigest({ ...base, totalScraped: 5 });
  assert.match(msg, /No new filings since the last run \(5 already seen\)/);
});

test('digest: partial failure is reported next to the results', () => {
  const [msg] = buildDigest({
    ...base, totalScraped: 1, newCount: 1,
    failures: [{ ticker: 'MMTC', error: 'NSE ECONNRESET; BSE HTTP 403' }],
    processed: [{ ticker: 'RPOWER', title: 'Board meeting outcome', importance: 2, isImportant: false, insights: null }],
  });
  assert.match(msg, /1\/8 companies: MMTC/);
  assert.match(msg, /<b>RPOWER<\/b> \(1\)/);
});

test('digest: titles and summaries are HTML-escaped', () => {
  const [msg] = buildDigest({
    ...base, totalScraped: 1, newCount: 1,
    processed: [{
      ticker: 'SHAKTIPUMP', title: 'Order <₹500 Cr> under Reg_30 & *SEBI*', importance: 5, isImportant: true,
      insights: { summary: 'Margin <guidance> raised & reiterated' },
    }],
  });
  assert.match(msg, /🔴 Order &lt;₹500 Cr&gt; under Reg_30 &amp; \*SEBI\*/);
  assert.match(msg, /<i>Margin &lt;guidance&gt; raised &amp; reiterated<\/i>/);
});

test('digest: unclassified filings get their own warning part', () => {
  const parts = buildDigest({
    ...base, totalScraped: 2, newCount: 2,
    processed: [{ ticker: 'A', title: 't', importance: 2, isImportant: false, insights: null }],
    unclassified: [{ ticker: 'B', title: 'Results for Q2' }],
  });
  assert.equal(parts.length, 2);
  assert.match(parts[1], /could not be classified/);
});

test('digest: no companies tracked', () => {
  assert.match(buildDigest({ ...base, companies: 0 })[0], /No companies are tracked/);
});
