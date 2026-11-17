import axios from 'axios';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-finance-2';
// api-inference.huggingface.co no longer resolves; serverless inference moved to the router.
const HF_API_URL = 'https://router.huggingface.co/hf-inference/models/BAAI/bge-small-en-v1.5/pipeline/feature-extraction';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Voyage's free tier allows ~3 requests and 10K tokens per minute; one transcript
// is ~20K tokens. Without retries every ingestion died with 429.
async function callVoyage(input: string[]): Promise<number[][]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await axios.post<{ data: Array<{ embedding: number[] }> }>(
        VOYAGE_API_URL,
        { input, model: VOYAGE_MODEL },
        { headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` }, timeout: 60_000 },
      );
      return res.data.data.map(d => d.embedding);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const retryable = status === 429 || (status != null && status >= 500) || (axios.isAxiosError(err) && !err.response);
      if (!retryable || attempt >= 8) throw err;
      const after = Number(axios.isAxiosError(err) ? err.response?.headers?.['retry-after'] : NaN);
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 21_000;
      console.warn(`[embed] Voyage ${status ?? 'network error'}, retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

async function callHF(inputs: string | string[]): Promise<number[][]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await axios.post<number[] | number[][]>(
        HF_API_URL,
        { inputs },
        { headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_TOKEN}` }, timeout: 60_000 },
      );
      const data = res.data;
      // single input returns flat array, batch returns nested
      return (Array.isArray(data[0]) ? data : [data]) as number[][];
    } catch (err) {
      // axios throws on non-2xx, so the old status check never retried a 503 cold start
      lastError = err;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status && status < 500 && status !== 429) break;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error(`HuggingFace embedding API failed: ${String((lastError as Error)?.message ?? lastError)}`);
}

export async function embedText(text: string): Promise<number[]> {
  if (process.env.VOYAGE_API_KEY) {
    const [embedding] = await callVoyage([text]);
    return embedding;
  }
  const [embedding] = await callHF(text);
  return embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (process.env.VOYAGE_API_KEY) return callVoyage(texts);
  return callHF(texts);
}
