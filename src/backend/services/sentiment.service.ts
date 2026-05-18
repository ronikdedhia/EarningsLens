import { pipeline, type TextClassificationPipeline } from '@huggingface/transformers';

export type SentimentLabel = 'positive' | 'negative' | 'neutral';

export interface SentimentScore {
  label: SentimentLabel;
  score: number;
}

let _pipe: TextClassificationPipeline | null = null;

async function getPipe(): Promise<TextClassificationPipeline> {
  if (!_pipe) {
    _pipe = await pipeline('text-classification', 'Xenova/finbert', {
      dtype: 'fp32',
      top_k: 1,
    }) as TextClassificationPipeline;
  }
  return _pipe;
}

const MAX_CHARS = 1800;

async function classify(text: string): Promise<SentimentScore> {
  const pipe = await getPipe();
  const result = await pipe(text.slice(0, MAX_CHARS), { top_k: 1 });
  const top = Array.isArray(result[0]) ? result[0][0] : result[0] as { label: string; score: number };
  return { label: top.label.toLowerCase() as SentimentLabel, score: top.score };
}

export async function scoreSentiment(text: string): Promise<SentimentScore> {
  return classify(text);
}

export async function scoreBatch(texts: string[]): Promise<SentimentScore[]> {
  const results: SentimentScore[] = [];
  for (const text of texts) {
    results.push(await classify(text));
  }
  return results;
}
