import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quarterToInt, orderChunks, packWindows, chunkBlocks, mergeRedFlags, dedupePromises,
} from '../src/backend/utils/transcript';
import { promisesDueFor } from '../src/backend/graphs/promises.graph';
import type { ChunkPayload } from '../src/backend/services/qdrant.service';

test('quarterToInt orders quarters across fiscal years', () => {
  assert.ok(quarterToInt('Q4FY26') < quarterToInt('Q1FY27'));
  assert.ok(quarterToInt('Q1FY26') < quarterToInt('Q2FY26'));
  assert.equal(quarterToInt('Q2FY2026'), quarterToInt('Q2FY26'));
  assert.equal(quarterToInt('garbage'), 0);
  assert.equal(quarterToInt('Q5FY26'), 0);
});

test('orderChunks sorts by chunkIndex and keeps legacy chunks after, in original order', () => {
  const chunks = [
    { chunkIndex: 2, id: 'c' }, { id: 'legacy1' }, { chunkIndex: 0, id: 'a' },
    { id: 'legacy2' }, { chunkIndex: 1, id: 'b' },
  ];
  assert.deepEqual(orderChunks(chunks).map(c => c.id), ['a', 'b', 'c', 'legacy1', 'legacy2']);
});

test('packWindows covers every block, respects the cap, never drops text', () => {
  const blocks = Array.from({ length: 50 }, (_, i) => `block-${i} `.repeat(30));
  const windows = packWindows(blocks, 2000);
  assert.ok(windows.length > 1);
  for (const w of windows) assert.ok(w.length <= 2000, `window of ${w.length}`);
  const joined = windows.join('\n\n');
  for (const b of blocks) assert.ok(joined.includes(b));
});

test('packWindows splits a single block larger than the window', () => {
  const big = 'x'.repeat(5000);
  const windows = packWindows([big], 2000);
  assert.equal(windows.join(''), big);
  assert.ok(windows.every(w => w.length <= 2000));
});

test('chunkBlocks labels Q&A section and speaker', () => {
  const c = (i: number, section: 'prepared' | 'qa', role: ChunkPayload['speakerRole']): ChunkPayload => ({
    ticker: 'X', quarter: 'Q1FY27', fiscalYear: 2027, speakerRole: role, speakerName: 'A B',
    topic: 't', text: `text${i}`, source: '', publishedAt: '', chunkIndex: i, section,
  });
  const blocks = chunkBlocks([c(1, 'qa', 'Analyst'), c(0, 'prepared', 'CEO')]);
  assert.equal(blocks[0], '[Prepared remarks · CEO A B] text0');
  assert.equal(blocks[1], '[Q&A · Analyst A B] text1');
});

test('mergeRedFlags keeps the most severe occurrence of each type', () => {
  const merged = mergeRedFlags([
    { flagType: 'deflected_questions', severity: 'Low', evidence: 'a' },
    { flagType: 'deflected_questions', severity: 'High', evidence: 'b' },
    { flagType: 'deflected_questions', severity: 'Medium', evidence: 'c' },
    { flagType: 'leadership_change', severity: 'Medium', evidence: 'd' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find(f => f.flagType === 'deflected_questions')!.evidence, 'b');
});

test('dedupePromises drops repeated and contained quotes, keeps higher confidence', () => {
  const out = dedupePromises([
    { verbatimQuote: 'We will reach 20% EBITDA margin by FY28.', confidenceScore: 3 },
    { verbatimQuote: 'we will reach 20% EBITDA margin by FY28', confidenceScore: 5 },
    { verbatimQuote: 'reach 20% EBITDA margin', confidenceScore: 2 },
    { verbatimQuote: 'Capex of 300 crore next year', confidenceScore: 4 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].confidenceScore, 5);
});

test('promisesDueFor only returns promises made before the new quarter', () => {
  const pending = [
    { id: 1, quarterPromised: 'Q4FY26' },
    { id: 2, quarterPromised: 'Q1FY27' }, // same quarter: cannot resolve itself
    { id: 3, quarterPromised: 'Q2FY27' }, // later quarter ingested out of order
    { id: 4, quarterPromised: 'bad' },
  ];
  assert.deepEqual(promisesDueFor(pending, 'Q1FY27').map(p => p.id), [1]);
});
