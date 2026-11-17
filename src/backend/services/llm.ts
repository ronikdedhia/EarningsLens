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
    // groq-sdk retries 429/5xx with backoff and honours retry-after.
    maxRetries: 5,
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
  return Number.isFinite(n) && n > 0 ? n : 2;
}

export async function withLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < maxConcurrency()) {
    active++;
  } else {
    // The releasing caller hands its slot straight to us, so `active` is unchanged.
    await new Promise<void>(resolve => waiting.push(resolve));
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
