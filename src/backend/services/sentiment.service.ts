import { HumanMessage } from '@langchain/core/messages';
import { SentimentBatchSchema } from '../schemas';
import { chatModel, withLlmSlot } from './llm';

export type SentimentLabel = 'positive' | 'negative' | 'neutral';

export interface SentimentScore {
  label: SentimentLabel;
  score: number;
}

const MAX_CHARS = 1200;
// One call classifies a whole batch. The old code made one call per chunk, all at
// once, which is ~150 simultaneous requests for a single transcript.
const BATCH_SIZE = 20;
const NEUTRAL: SentimentScore = { label: 'neutral', score: 0.5 };

async function classifyBatch(texts: string[]): Promise<SentimentScore[]> {
  const numbered = texts
    .map((t, i) => `[${i}] ${t.slice(0, MAX_CHARS).replace(/\s+/g, ' ')}`)
    .join('\n\n');
  const prompt =
    'You are a financial sentiment classifier for earnings call excerpts.\n' +
    'For every numbered excerpt return its index, a label (positive, negative or neutral) and a ' +
    'confidence score between 0 and 1. Return one result per excerpt.\n\n' + numbered;

  const model = chatModel('fast', { temperature: 0, maxTokens: 40 * texts.length + 100 })
    .withStructuredOutput(SentimentBatchSchema);
  const result = await withLlmSlot(() => model.invoke([new HumanMessage(prompt)]));

  const byIndex = new Map(result.results.map(r => [r.index, r]));
  return texts.map((_, i) => {
    const r = byIndex.get(i);
    return r ? { label: r.label as SentimentLabel, score: r.score } : NEUTRAL;
  });
}

export async function scoreBatch(texts: string[]): Promise<SentimentScore[]> {
  const out: SentimentScore[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      out.push(...await classifyBatch(batch));
    } catch (err) {
      // Sentiment is decoration on the chunks; a failed batch must not abort ingestion.
      console.error('[sentiment] batch failed, marking neutral:', String(err).slice(0, 200));
      out.push(...batch.map(() => NEUTRAL));
    }
  }
  return out;
}
