import axios from 'axios';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-finance-2';
const HF_API_URL = 'https://api-inference.huggingface.co/models/BAAI/bge-small-en-v1.5';

async function callVoyage(input: string[]): Promise<number[][]> {
  const res = await axios.post<{ data: Array<{ embedding: number[] }> }>(
    VOYAGE_API_URL,
    { input, model: VOYAGE_MODEL },
    { headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` } },
  );
  return res.data.data.map(d => d.embedding);
}

async function callHF(inputs: string | string[]): Promise<number[][]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await axios.post<number[] | number[][]>(
      HF_API_URL,
      { inputs },
      { headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_TOKEN}` } },
    );
    if (res.status === 200) {
      const data = res.data;
      // single input returns flat array, batch returns nested
      return (Array.isArray(data[0]) ? data : [data]) as number[][];
    }
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error('HuggingFace embedding API unavailable after retries');
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
