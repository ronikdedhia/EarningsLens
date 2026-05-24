import Groq from 'groq-sdk';

export type SentimentLabel = 'positive' | 'negative' | 'neutral';

export interface SentimentScore {
  label: SentimentLabel;
  score: number;
}

let _groq: Groq | null = null;
function groq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}
const MAX_CHARS = 1800;

const PROMPT = (text: string) =>
  `You are a financial sentiment classifier. Classify the sentiment of the text below as exactly one of: positive, negative, neutral.\n\nRespond with only valid JSON in this format: {"label": "positive", "score": 0.87}\n\nText: ${text}`;

async function classify(text: string): Promise<SentimentScore> {
  const response = await groq().chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant',
    messages: [{ role: 'user', content: PROMPT(text.slice(0, MAX_CHARS)) }],
    response_format: { type: 'json_object' },
    max_tokens: 30,
    temperature: 0,
  });
  const parsed = JSON.parse(response.choices[0].message.content ?? '{}');
  const label = (['positive', 'negative', 'neutral'].includes(parsed.label)
    ? parsed.label
    : 'neutral') as SentimentLabel;
  const score = typeof parsed.score === 'number' ? parsed.score : 0.5;
  return { label, score };
}

export async function scoreSentiment(text: string): Promise<SentimentScore> {
  return classify(text);
}

export async function scoreBatch(texts: string[]): Promise<SentimentScore[]> {
  return Promise.all(texts.map(classify));
}
