import { Router, Request, Response } from 'express';
import { runRAGQuery } from '../rag/chain';
import { getInsights, saveInsight, deleteInsights, getQueryLogsForTicker } from '../services/turso.service';
import { sendEmail, insightsEmail } from '../services/email.service';

const router = Router();

// Strip LLM preamble boilerplate before storing
function stripBoilerplate(text: string): string {
  return text
    // "Based on the provided transcript excerpts, [anything up to colon]:"
    .replace(/^based on (the |these )?(provided )?transcript excerpts?[^:\n]*[:\n]\s*/im, '')
    // "According to the transcript[s], [name] said:" or similar
    .replace(/^according to (the )?transcripts?[^:\n]*[:\n]\s*/im, '')
    // "Here are the key [anything]:" opener lines
    .replace(/^here are (the )?[^:\n]+[:\n]\s*/im, '')
    // "The following [anything]:" opener
    .replace(/^the following [^:\n]+[:\n]\s*/im, '')
    .trim();
}

// Five focused prompts that produce concise, data-rich insights
const INSIGHT_PROMPTS: Array<{ title: string; prompt: (ticker: string) => string }> = [
  {
    title: 'Financial Performance',
    prompt: (t) =>
      `Summarize ${t}'s key financial metrics across recent quarters — revenue growth, net profit, margins, NIM (if bank), or EBIT. Cite specific numbers and quarter labels. Be concise and factual.`,
  },
  {
    title: 'Management Guidance',
    prompt: (t) =>
      `What forward guidance did ${t} management give about growth targets, margins, and business outlook? Quote specific statements with speaker name and quarter.`,
  },
  {
    title: 'Key Risks & Concerns',
    prompt: (t) =>
      `What are the main risks, challenges, and concerns highlighted in ${t} earnings calls — by both management and analysts? List the top 3–4 with brief explanation.`,
  },
  {
    title: 'Strategic Initiatives',
    prompt: (t) =>
      `What major strategic initiatives, product launches, partnerships, or business model changes did ${t} announce or discuss across recent quarters?`,
  },
  {
    title: 'Management Tone & Confidence',
    prompt: (t) =>
      `How would you characterise the overall management tone in ${t} earnings calls? Has confidence improved or declined across quarters? Point to specific language or metrics as evidence.`,
  },
];

// GET /api/insights/:ticker — returns stored insights + recent Q&A
router.get('/:ticker', async (req: Request, res: Response) => {
  const ticker = req.params.ticker.toUpperCase();
  const [insights, queryLogs] = await Promise.all([
    getInsights(ticker),
    getQueryLogsForTicker(ticker),
  ]);
  return res.json({ ticker, insights, queryLogs });
});

// POST /api/insights/generate/:ticker — generates + stores insights (re-generate if force=true)
router.post('/generate/:ticker', async (req: Request, res: Response) => {
  const ticker = req.params.ticker.toUpperCase();
  const force  = req.query.force === 'true';

  const existing = await getInsights(ticker);
  if (existing.length > 0 && !force) {
    return res.json({ ticker, insights: existing, cached: true });
  }

  await deleteInsights(ticker);

  const generated: Array<{ title: string; content: string }> = [];

  for (const { title, prompt } of INSIGHT_PROMPTS) {
    try {
      const { answer } = await runRAGQuery(prompt(ticker), { ticker, topK: 12 });
      const clean = stripBoilerplate(answer);
      if (clean && !clean.startsWith('No relevant')) {
        await saveInsight(ticker, title, clean);
        generated.push({ title, content: clean });
      }
    } catch {
      // skip failed insight — don't crash the whole generation
    }
  }

  const insights = await getInsights(ticker);

  if (generated.length > 0) {
    const { subject, html } = insightsEmail(ticker, generated);
    sendEmail(subject, html).catch(() => {});
  }

  return res.json({ ticker, insights, cached: false });
});

export { router as insightsRouter };
