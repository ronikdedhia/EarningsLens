import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { modelId, isReasoningModel, withLlmSlot, DEFAULT_MAIN_MODEL, DEFAULT_FAST_MODEL } from '../src/backend/services/llm';
import { parseSpeakers } from '../src/backend/utils/speaker-parser';
import { concallDateToQuarter } from '../src/backend/services/screener.service';
import { CURL_ARGS } from '../src/backend/utils/pdf';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

test('model ids default to models Groq still serves, env overrides', () => {
  delete process.env.GROQ_MODEL;
  delete process.env.GROQ_FAST_MODEL;
  assert.equal(modelId('main'), DEFAULT_MAIN_MODEL);
  assert.equal(modelId('fast'), DEFAULT_FAST_MODEL);
  assert.doesNotMatch(modelId('main'), /llama-3\.[13]/);
  process.env.GROQ_MODEL = 'custom/model';
  assert.equal(modelId('main'), 'custom/model');
});

test('reasoning models are detected so they get token headroom', () => {
  assert.equal(isReasoningModel('openai/gpt-oss-20b'), true);
  assert.equal(isReasoningModel('qwen/qwen3.8-27b'), true);
  assert.equal(isReasoningModel('llama-3.1-8b-instant'), false);
});

test('withLlmSlot never runs more than GROQ_CONCURRENCY calls at once', async () => {
  process.env.GROQ_CONCURRENCY = '2';
  let active = 0;
  let peak = 0;
  const task = () => withLlmSlot(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
  });
  await Promise.all(Array.from({ length: 12 }, task));
  assert.equal(peak, 2);
});

test('withLlmSlot releases the slot when the call throws', async () => {
  process.env.GROQ_CONCURRENCY = '1';
  await assert.rejects(withLlmSlot(async () => { throw new Error('boom'); }));
  assert.equal(await withLlmSlot(async () => 'ok'), 'ok');
});

test('parseSpeakers splits turns and assigns roles', () => {
  const transcript = [
    'Moderator: Ladies and gentlemen, welcome to the earnings call. We will now begin the session.',
    'Rahul Mehta (Chief Financial Officer): Revenue grew 18% year on year and EBITDA margin expanded by 120 basis points.',
    'Priya Shah (Analyst, ABC Securities): Could you talk about the order book and the export pipeline for next year?',
  ].join('\n');
  const turns = parseSpeakers(transcript);
  assert.deepEqual(turns.map(t => t.role), ['Moderator', 'CFO', 'Analyst']);
});

test('concall month maps to the quarter being discussed', () => {
  assert.equal(concallDateToQuarter(8, 2026), 'Q1FY27');  // Aug call → Apr–Jun quarter
  assert.equal(concallDateToQuarter(11, 2026), 'Q2FY27');
  assert.equal(concallDateToQuarter(2, 2027), 'Q3FY27');
  assert.equal(concallDateToQuarter(5, 2027), 'Q4FY27');
});

test('curl args put the URL last, after --', () => {
  const args = CURL_ARGS('-o/etc/passwd');
  assert.equal(args[args.length - 1], '-o/etc/passwd');
  assert.equal(args[args.length - 2], '--');
  assert.ok(CURL_ARGS('https://nsearchives.nseindia.in/x.pdf').includes('Referer: https://www.nseindia.com/'));
});
