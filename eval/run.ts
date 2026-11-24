/**
 * Evaluation harness for the RAG pipeline. Read-only: it queries Qdrant and
 * calls the LLMs, and never writes to Qdrant or Turso.
 *
 *   npm run eval                 # every question in eval/golden.jsonl
 *   npm run eval -- --limit 10   # first 10 only
 *
 * Writes eval/results/latest.json (per-question detail) and
 * eval/results/spot-check.md (20 judge verdicts to check by hand).
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { embedText } from '../src/backend/services/embedding.service';
import { searchChunks, type ChunkPayload } from '../src/backend/services/qdrant.service';
import { runRAGQuery } from '../src/backend/rag/chain';
import { chatModel, withLlmSlot } from '../src/backend/services/llm';

// ── Config ────────────────────────────────────────────────────────────────────
const TOP_K = 5;
const SPOT_CHECK_COUNT = 20;
// USD per 1M tokens. Check these against https://groq.com/pricing before quoting a number.
const LLM_PRICES: Record<string, { input: number; output: number }> = {
  'openai/gpt-oss-120b': { input: 0.15, output: 0.60 },
  'openai/gpt-oss-20b':  { input: 0.075, output: 0.30 },
};
const VOYAGE_USD_PER_1M = 0.12;      // voyage-finance-2
const COHERE_RERANK_USD = 0.002;     // per rerank call ($2 per 1,000 searches)
const USD_TO_INR = Number(process.env.EVAL_USD_TO_INR) || 88;

// ── Golden set ────────────────────────────────────────────────────────────────
interface GoldenItem {
  id:              string;
  question:        string;
  ticker:          string;
  quarter:         string;  // quarter of the chunk that holds the answer, e.g. "Q2FY26"
  expected_answer: string;
  evidence:        string;  // short verbatim quote from that chunk (under ~200 chars)
}

function loadGolden(file: string): GoldenItem[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//'))
    .map((l, i) => {
      const item = JSON.parse(l) as GoldenItem;
      for (const k of ['id', 'question', 'ticker', 'quarter', 'expected_answer', 'evidence'] as const) {
        if (!item[k]) throw new Error(`golden.jsonl line ${i + 1}: missing "${k}"`);
      }
      return item;
    });
}

// Chunk IDs are random UUIDs that change on re-ingest, so the right chunk is
// found by ticker + quarter + the evidence quote instead.
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
function isGoldChunk(c: ChunkPayload, g: GoldenItem): boolean {
  return c.ticker === g.ticker && c.quarter === g.quarter && norm(c.text).includes(norm(g.evidence));
}

// ── Token metering ────────────────────────────────────────────────────────────
// The pipeline's output parsers drop usage metadata, so wrap ChatGroq.invoke in
// this process only. The app's own code is untouched.
type Bucket = Record<string, { input: number; output: number }>;
let bucket: Bucket = {};
const proto = ChatGroq.prototype as unknown as { invoke: (...a: unknown[]) => Promise<unknown>; model: string };
const originalInvoke = proto.invoke;
proto.invoke = async function (this: { model: string }, ...args: unknown[]) {
  const res = await originalInvoke.apply(this, args) as { usage_metadata?: { input_tokens?: number; output_tokens?: number } };
  const u = res?.usage_metadata;
  if (u) {
    const b = (bucket[this.model] ??= { input: 0, output: 0 });
    b.input  += u.input_tokens ?? 0;
    b.output += u.output_tokens ?? 0;
  }
  return res;
};
function llmCostUsd(b: Bucket): number {
  return Object.entries(b).reduce((sum, [model, t]) => {
    const p = LLM_PRICES[model];
    if (!p) { console.warn(`[eval] no price for ${model}, counted as 0`); return sum; }
    return sum + (t.input * p.input + t.output * p.output) / 1e6;
  }, 0);
}

// ── Faithfulness judge ────────────────────────────────────────────────────────
const JudgeSchema = z.object({
  claims: z.array(z.object({
    claim:     z.string().describe('one factual claim made in the answer'),
    supported: z.boolean().describe('true only if the excerpts state this claim'),
    reason:    z.string().describe('short quote from the excerpts, or why it is unsupported'),
  })),
});
type Judgement = z.infer<typeof JudgeSchema>;

const JUDGE_SYSTEM = `You check whether an answer is faithful to source excerpts.
Split the answer into its individual factual claims (numbers, guidance, events, attributions).
Skip claims that only say information is unavailable, and skip citations or formatting.
For each claim, set supported=true only if the excerpts directly state it. Paraphrase is fine; inference, outside knowledge and rounding changes are not.
Return an empty claims array if the answer makes no factual claims.`;

async function judge(answer: string, excerpts: string[]): Promise<Judgement> {
  const structured = chatModel('main', { temperature: 0, maxTokens: 1500 }).withStructuredOutput(JudgeSchema);
  return withLlmSlot(() => structured.invoke([
    new SystemMessage(JUDGE_SYSTEM),
    new HumanMessage(`Excerpts:\n\n${excerpts.map((e, i) => `[${i + 1}] ${e}`).join('\n\n')}\n\n---\n\nAnswer:\n${answer}`),
  ])) as Promise<Judgement>;
}

// ── Run ───────────────────────────────────────────────────────────────────────
interface Row {
  id: string; question: string; expected_answer: string; answer: string;
  retrieval_hit: boolean; retrieval_rank: number | null;
  faithfulness: number | null; claims: Judgement['claims'];
  tokens: Bucket; cost_inr: number; error?: string;
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
  const golden = loadGolden(path.join(__dirname, 'golden.jsonl')).slice(0, limit);
  if (!golden.length) {
    console.error('eval/golden.jsonl has no questions yet. See eval/README.md for the format.');
    process.exit(1);
  }

  const rows: Row[] = [];
  for (const [i, g] of golden.entries()) {
    process.stdout.write(`[${i + 1}/${golden.length}] ${g.id} … `);
    try {
      // Retrieval accuracy: plain vector search, top 5, filtered to the ticker as the app does.
      const vec  = await embedText(g.question);
      const hits = (await searchChunks(vec, { ticker: g.ticker }, TOP_K)).map(h => h.payload as unknown as ChunkPayload);
      const rank = hits.findIndex(c => isGoldChunk(c, g));

      // Full pipeline with production settings, metered for cost.
      bucket = {};
      const rag = await runRAGQuery(g.question, { ticker: g.ticker });
      const pipelineTokens = bucket;
      const embedUsd  = process.env.VOYAGE_API_KEY ? (g.question.length / 4) * VOYAGE_USD_PER_1M / 1e6 : 0;
      const rerankUsd = process.env.COHERE_API_KEY && rag.citations.length > 1 ? COHERE_RERANK_USD : 0;
      const costInr   = (llmCostUsd(pipelineTokens) + embedUsd + rerankUsd) * USD_TO_INR;

      // Faithfulness against the chunks the answer was generated from. Judge tokens aren't counted.
      let verdict: Judgement = { claims: [] };
      if (rag.citations.length) verdict = await judge(rag.answer, rag.citations.map(c => c.text));
      const n = verdict.claims.length;
      const faithfulness = n ? verdict.claims.filter(c => c.supported).length / n : null;

      rows.push({
        id: g.id, question: g.question, expected_answer: g.expected_answer, answer: rag.answer,
        retrieval_hit: rank > -1, retrieval_rank: rank > -1 ? rank + 1 : null,
        faithfulness, claims: verdict.claims, tokens: pipelineTokens, cost_inr: costInr,
      });
      console.log(`${rank > -1 ? `hit@${rank + 1}` : 'miss'}  faith=${faithfulness == null ? 'n/a' : faithfulness.toFixed(2)}  ₹${costInr.toFixed(3)}`);
    } catch (err) {
      console.log(`error: ${String(err).slice(0, 160)}`);
      rows.push({
        id: g.id, question: g.question, expected_answer: g.expected_answer, answer: '',
        retrieval_hit: false, retrieval_rank: null, faithfulness: null, claims: [],
        tokens: {}, cost_inr: 0, error: String(err),
      });
    }
  }

  const ok      = rows.filter(r => !r.error);
  const judged  = ok.filter(r => r.faithfulness != null);
  const claims  = judged.flatMap(r => r.claims);
  const mean    = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const summary = {
    run_at:                    new Date().toISOString(),
    questions:                 rows.length,
    errors:                    rows.length - ok.length,
    retrieval_accuracy_top5:   mean(ok.map(r => (r.retrieval_hit ? 1 : 0))),
    mrr_top5:                  mean(ok.map(r => (r.retrieval_rank ? 1 / r.retrieval_rank : 0))),
    faithfulness_mean:         mean(judged.map(r => r.faithfulness!)),
    claims_supported_fraction: claims.length ? claims.filter(c => c.supported).length / claims.length : 0,
    answers_judged:            judged.length,
    cost_inr_per_query:        mean(ok.map(r => r.cost_inr)),
    usd_to_inr:                USD_TO_INR,
    models:                    { main: process.env.GROQ_MODEL, fast: process.env.GROQ_FAST_MODEL },
  };

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify({ summary, rows }, null, 2));
  fs.writeFileSync(path.join(outDir, 'spot-check.md'), spotCheck(judged));

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log('\n── Summary ──');
  console.log(`Questions:                 ${summary.questions} (${summary.errors} errors)`);
  console.log(`Retrieval accuracy (top 5): ${pct(summary.retrieval_accuracy_top5)}   MRR ${summary.mrr_top5.toFixed(3)}`);
  console.log(`Answer faithfulness:       ${pct(summary.faithfulness_mean)} mean over ${judged.length} answers (${pct(summary.claims_supported_fraction)} of claims supported)`);
  console.log(`Cost per query:            ₹${summary.cost_inr_per_query.toFixed(3)}`);
  console.log(`\nWrote eval/results/latest.json and eval/results/spot-check.md`);
}

/** Picks 20 verdicts spread across the run, weighted toward unsupported claims. */
function spotCheck(rows: Row[]): string {
  const all = rows.flatMap(r => r.claims.map(c => ({ id: r.id, ...c })));
  const unsupported = all.filter(c => !c.supported);
  const supported   = all.filter(c => c.supported);
  const half = Math.min(unsupported.length, SPOT_CHECK_COUNT / 2);
  const pick = <T,>(xs: T[], n: number) => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / n)) === 0).slice(0, n);
  const sample = [...pick(unsupported, half), ...pick(supported, SPOT_CHECK_COUNT - half)];
  const lines = [
    '# Judge spot-check',
    '',
    'For each claim, open the question in `latest.json`, read the retrieved chunks, and mark whether you agree with the judge.',
    'Judge agreement = agreed / checked. Quote it next to the faithfulness number.',
    '',
    '| # | Question | Claim | Judge | Judge reason | You agree? (Y/N) |',
    '|---|---|---|---|---|---|',
    ...sample.map((c, i) =>
      `| ${i + 1} | ${c.id} | ${c.claim.replace(/\|/g, '/')} | ${c.supported ? 'supported' : 'UNSUPPORTED'} | ${c.reason.replace(/\|/g, '/').slice(0, 160)} | |`),
  ];
  return lines.join('\n') + '\n';
}

main().catch(err => { console.error(err); process.exit(1); });
