import { ChatGroq } from '@langchain/groq';

// Groq shut down llama-3.1-8b-instant and llama-3.3-70b-versatile on 2026-08-16
// (https://console.groq.com/docs/deprecations). Model IDs live in env so the next
// deprecation is a config change, not a code change.
export const DEFAULT_MAIN_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_FAST_MODEL = 'openai/gpt-oss-20b';

export type ModelTier = 'main' | 'fast';

export function modelId(tier: ModelTier): string {
  return tier === 'fast'
    ? process.env.GROQ_FAST_MODEL || DEFAULT_FAST_MODEL
    : process.env.GROQ_MODEL || DEFAULT_MAIN_MODEL;
}

// gpt-oss and qwen3 spend part of max_completion_tokens on hidden reasoning.
// Without headroom a 50-token sentiment answer gets cut off mid-reasoning.
export function isReasoningModel(id: string): boolean {
  return /gpt-oss|qwen3/i.test(id);
}

const REASONING_HEADROOM = 1024;

export function chatModel(
  tier: ModelTier,
  { temperature = 0.1, maxTokens = 1024 }: { temperature?: number; maxTokens?: number } = {},
): ChatGroq {
  const model = modelId(tier);
  const reasoning = isReasoningModel(model);
  return new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model,
    temperature,
    maxTokens: reasoning ? maxTokens + REASONING_HEADROOM : maxTokens,
    // 5xx retries here; 429s are waited out in withLlmSlot with Groq's own delay.
    maxRetries: 2,
    ...(reasoning ? { reasoningEffort: 'low' as const } : {}),
  });
}

// ── Concurrency limit ─────────────────────────────────────────────────────────
// One ingestion fans out into dozens of calls. Without a cap they all hit Groq at
// once and trip the per-minute limits; the cap applies across the whole process.

let active = 0;
const waiting: Array<() => void> = [];

function maxConcurrency(): number {
  const n = parseInt(process.env.GROQ_CONCURRENCY ?? '', 10);
  // 1 by default: on Groq's on-demand tier two concurrent transcript windows
  // already exceed the 8K tokens/minute limit.
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Seconds Groq asks us to wait, from "Please try again in 7.4s" / "in 1m2.5s",
 * or null when the error isn't a rate limit.
 */
export function rateLimitWaitSeconds(err: unknown): number | null {
  const msg = String((err as { message?: string })?.message ?? err);
  const status = (err as { status?: number })?.status;
  if (status !== 429 && !/\b429\b|rate limit/i.test(msg)) return null;
  const m = msg.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (m) return (m[1] ? +m[1] * 60 : 0) + parseFloat(m[2]);
  return 20;
}

/**
 * Groq asked for a wait longer than we're willing to block for: that's the daily
 * token cap, not the per-minute one. Callers treat it as "try again tomorrow".
 */
export class DailyLimitError extends Error {
  constructor(public waitSeconds: number) {
    super(`Groq daily token limit reached (retry in ${Math.round(waitSeconds / 60)} min)`);
  }
}

function maxWaitSeconds(): number {
  const n = Number(process.env.GROQ_MAX_WAIT_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

export async function withLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < maxConcurrency()) {
    active++;
  } else {
    // The releasing caller hands its slot straight to us, so `active` is unchanged.
    await new Promise<void>(resolve => waiting.push(resolve));
  }
  try {
    // Groq's free/on-demand tier caps gpt-oss-120b at 8K tokens per minute, and
    // its SDK retries give up long before the minute resets.
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const wait = rateLimitWaitSeconds(err);
        if (wait == null || attempt >= 8) throw err;
        if (wait > maxWaitSeconds()) throw new DailyLimitError(wait);
        console.warn(`[llm] Groq rate limit, waiting ${wait.toFixed(1)}s`);
        await new Promise(r => setTimeout(r, Math.ceil((wait + 1) * 1000)));
      }
    }
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
