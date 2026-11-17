import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, splitMessage, notifyAsync, TELEGRAM_MAX } from '../src/backend/services/telegram.service';

const realFetch = globalThis.fetch;
const ENV = { ...process.env };
type Call = { body: Record<string, unknown> };
let calls: Call[] = [];

function mockTelegram(responses: Array<{ status: number; body: Record<string, unknown> }>) {
  calls = [];
  let i = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.TELEGRAM_ACCESS_TOKEN = 'token';
  process.env.TELEGRAM_CHAT_ID = '123';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...ENV };
});

test('escapeHtml escapes the three characters Telegram HTML cares about', () => {
  assert.equal(escapeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  // Markdown specials pass through untouched; they broke the old parse_mode=Markdown
  assert.equal(escapeHtml('Reg_30 *final* [draft]'), 'Reg_30 *final* [draft]');
});

test('splitMessage keeps every part under the limit and loses nothing', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `  · filing title number ${i} with some words`);
  const msg = lines.join('\n');
  const parts = splitMessage(msg);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= TELEGRAM_MAX);
  assert.equal(parts.join('\n'), msg);
});

test('splitMessage returns a short message unchanged', () => {
  assert.deepEqual(splitMessage('hello'), ['hello']);
});

test('notifyAsync sends HTML parse mode', async () => {
  mockTelegram([{ status: 200, body: { ok: true } }]);
  await notifyAsync('<b>hi</b>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.equal(calls[0].body.chat_id, '123');
});

test('notifyAsync resends as plain text when Telegram rejects the formatting', async () => {
  mockTelegram([
    { status: 400, body: { ok: false, description: "Bad Request: can't parse entities: Can't find end tag" } },
    { status: 200, body: { ok: true } },
  ]);
  await notifyAsync('<b>WOCKPHARMA</b> Cessation &amp; more');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.parse_mode, undefined);
  assert.equal(calls[1].body.text, 'WOCKPHARMA Cessation & more');
});

test('notifyAsync waits out a 429 and retries', async () => {
  mockTelegram([
    { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 0 } } },
    { status: 200, body: { ok: true } },
  ]);
  await notifyAsync('x');
  assert.equal(calls.length, 2);
});

test('notifyAsync surfaces Telegram\'s error instead of swallowing it', async () => {
  mockTelegram([{ status: 403, body: { ok: false, description: 'Forbidden: bot was kicked from the channel chat' } }]);
  await assert.rejects(notifyAsync('x'), /bot was kicked/);
});

test('notifyAsync is a no-op without credentials', async () => {
  delete process.env.TELEGRAM_ACCESS_TOKEN;
  mockTelegram([{ status: 200, body: { ok: true } }]);
  await notifyAsync('x');
  assert.equal(calls.length, 0);
});
