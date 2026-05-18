import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

let _pipe: FeatureExtractionPipeline | null = null;

async function getPipe(): Promise<FeatureExtractionPipeline> {
  if (!_pipe) {
    _pipe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
      dtype: 'fp32',
    }) as FeatureExtractionPipeline;
  }
  return _pipe;
}

export async function embedText(text: string): Promise<number[]> {
  const pipe = await getPipe();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const pipe = await getPipe();
  const output = await pipe(texts, { pooling: 'mean', normalize: true });
  const data = output.data as Float32Array;
  const dim = data.length / texts.length;
  return Array.from({ length: texts.length }, (_, i) =>
    Array.from(data.slice(i * dim, (i + 1) * dim)),
  );
}
