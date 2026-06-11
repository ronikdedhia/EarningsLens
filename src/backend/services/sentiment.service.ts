import { ChatGroq } from '@langchain/groq';
import { HumanMessage } from '@langchain/core/messages';
import { SentimentSchema } from '../schemas';

export type SentimentLabel = 'positive' | 'negative' | 'neutral';

export interface SentimentScore {
  label: SentimentLabel;
  score: number;
}

const MAX_CHARS = 1800;

function sentimentChain() {
  return new ChatGroq({
    apiKey:    process.env.GROQ_API_KEY,
    model:     'llama-3.1-8b-instant',
    temperature: 0,
    maxTokens: 50,
  }).withStructuredOutput(SentimentSchema);
}

async function classify(text: string): Promise<SentimentScore> {
  const result = await sentimentChain().invoke([
    new HumanMessage(
      `You are a financial sentiment classifier. Classify the sentiment of the text below as positive, negative, or neutral.\n\nText: ${text.slice(0, MAX_CHARS)}`
    ),
  ]);
  return {
    label: result.label as SentimentLabel,
    score: typeof result.score === 'number' ? result.score : 0.5,
  };
}

export async function scoreBatch(texts: string[]): Promise<SentimentScore[]> {
  return Promise.all(texts.map(classify));
}
