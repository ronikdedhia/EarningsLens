import Groq from 'groq-sdk';

let _groq: Groq | null = null;

function groq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

const SYSTEM_PROMPT = `You are a financial analyst assistant specializing in earnings call analysis.
Answer questions using ONLY the provided transcript excerpts.
Always cite the specific ticker, quarter, and speaker role (CEO/CFO).
If the context is insufficient, say so — do not infer or fabricate financial data.`;

export async function synthesize(query: string, context: string): Promise<string> {
  const completion = await groq().chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.1-70b-versatile',
    temperature: 0.1,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Transcript context:\n\n${context}\n\n---\n\nQuestion: ${query}`,
      },
    ],
  });

  return completion.choices[0].message.content ?? '';
}

// ── Management Quality Scoring ────────────────────────────────────────────────

export interface ManagementQualityScore {
  confidence:    number;
  transparency:  number;
  followThrough: number;
  summary:       string;
  hedgeWords:    string[];
  prevPromises:  string[];
  deliveryNote:  string;
}

function clamp(n: unknown): number {
  return Math.round(Math.max(0, Math.min(100, Number(n) || 50)));
}

// ── Sector Narrative Extraction ───────────────────────────────────────────────

export interface SectorThemeResult {
  theme: string;
  summary: string;
  companies: string[];
  optimistic: string[];
  cautious: string[];
}

export interface SectorEmergingResult {
  topic: string;
  companies: string[];
  context: string;
}

export interface SectorAnalysisResult {
  themes: SectorThemeResult[];
  emerging: SectorEmergingResult[];
}

export async function extractSectorThemes(
  sector: string,
  quarter: string,
  companyTexts: Record<string, string>,
  prevQuarterThemes?: string[],
): Promise<SectorAnalysisResult> {
  const tickers = Object.keys(companyTexts);
  const context = tickers
    .map(t => `=== ${t} ===\n${companyTexts[t].slice(0, 1500)}`)
    .join('\n\n');

  const prevContext = prevQuarterThemes?.length
    ? `\n\nThemes from 2 quarters ago (for emerging topic detection): ${prevQuarterThemes.join(', ')}`
    : '';

  const systemPrompt = `You are a sector analyst studying earnings call transcripts from ${tickers.length} ${sector} companies for ${quarter}.

Companies included: ${tickers.join(', ')}

Identify the top 5 dominant themes being discussed ACROSS these companies — not per-company, but as a sector-wide picture.

For each theme:
- theme: short name (3–5 words, e.g. "NIM compression", "Deposit mobilisation")
- summary: one sentence on what's happening across the sector on this theme
- companies: which tickers discuss this theme (subset of [${tickers.join(', ')}])
- optimistic: tickers whose management sounds positive/confident on this theme
- cautious: tickers whose management sounds worried/defensive on this theme${prevContext}

Also identify up to 3 emerging topics — themes present NOW that did NOT appear in older quarters.
- topic: short name
- companies: which tickers raise this topic
- context: one sentence on why it's new/significant

Respond ONLY with valid JSON, no other text:
{
  "themes": [{"theme":"...","summary":"...","companies":[...],"optimistic":[...],"cautious":[...]}],
  "emerging": [{"topic":"...","companies":[...],"context":"..."}]
}`;

  const completion = await groq().chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.1-70b-versatile',
    temperature: 0.15,
    max_tokens: 1200,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: context },
    ],
  });

  const raw = completion.choices[0].message.content ?? '{}';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  try {
    const p = JSON.parse(jsonMatch?.[0] ?? raw);
    const validTickers = new Set(tickers);
    const filterTickers = (arr: unknown[]) =>
      Array.isArray(arr) ? arr.filter(t => validTickers.has(String(t))).map(String) : [];
    return {
      themes: Array.isArray(p.themes)
        ? p.themes.slice(0, 5).map((t: Record<string, unknown>) => ({
            theme:      String(t.theme ?? ''),
            summary:    String(t.summary ?? ''),
            companies:  filterTickers(t.companies as unknown[]),
            optimistic: filterTickers(t.optimistic as unknown[]),
            cautious:   filterTickers(t.cautious as unknown[]),
          }))
        : [],
      emerging: Array.isArray(p.emerging)
        ? p.emerging.slice(0, 3).map((e: Record<string, unknown>) => ({
            topic:     String(e.topic ?? ''),
            companies: filterTickers(e.companies as unknown[]),
            context:   String(e.context ?? ''),
          }))
        : [],
    };
  } catch {
    return { themes: [], emerging: [] };
  }
}

// ── Red Flag Scanner ──────────────────────────────────────────────────────────

export const RED_FLAG_TYPES = [
  'exceptional_charges',
  'deflected_questions',
  'regulatory_language_spike',
  'accounting_terminology_change',
  'leadership_change',
  'compensating_language',
  'analyst_adversarial',
  'guidance_range_widening',
  'capex_guidance_cut',
] as const;

export type RedFlagType = typeof RED_FLAG_TYPES[number];

export interface DetectedRedFlag {
  flagType: RedFlagType;
  severity: 'Low' | 'Medium' | 'High';
  evidence: string;
}

export async function scanRedFlags(
  ticker: string,
  quarter: string,
  transcriptText: string,
): Promise<DetectedRedFlag[]> {
  const systemPrompt = `You are a financial risk analyst scanning an earnings call transcript for ${ticker} ${quarter} for qualitative red flags.

Scan for ONLY flags that have clear evidence in the transcript. Do NOT fabricate.

Flag taxonomy — check each and include ONLY if genuinely present:
1. exceptional_charges — mentions of "one-time items", "exceptional charges", "write-offs" not previously signalled
2. deflected_questions — analyst asks a direct question, management gives a non-answer or changes subject
3. regulatory_language_spike — sudden new or increased mentions of investigations, regulatory scrutiny, legal proceedings
4. accounting_terminology_change — changes in how revenue, margins, or accounting terms are defined vs prior calls
5. leadership_change — mention of CEO, CFO, MD change, succession, or departure
6. compensating_language — excessive positivity ("best ever", "incredible quarter") immediately after bad numbers
7. analyst_adversarial — analyst asks same question multiple times or pushes back hard on management answers
8. guidance_range_widening — guidance expressed as a wide range where it was previously specific
9. capex_guidance_cut — capital expenditure targets reduced or deferred without clear explanation

For each flag FOUND, return:
- flagType: exact key from list above
- severity: "Low" | "Medium" | "High"
- evidence: one verbatim quote (under 150 chars) that triggered this flag

Return ONLY found flags as a JSON array. Return [] if none found.
Respond ONLY with a JSON array, no other text:
[{"flagType":"...","severity":"...","evidence":"..."},...]`;

  const completion = await groq().chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.1-70b-versatile',
    temperature: 0.1,
    max_tokens: 1200,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: transcriptText.slice(0, 10000) },
    ],
  });

  const raw = completion.choices[0].message.content ?? '[]';
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  try {
    const parsed = JSON.parse(arrMatch?.[0] ?? raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f: Record<string, unknown>) => RED_FLAG_TYPES.includes(f.flagType as RedFlagType))
      .map((f: Record<string, unknown>) => ({
        flagType: f.flagType as RedFlagType,
        severity: (['Low', 'Medium', 'High'].includes(f.severity as string) ? f.severity : 'Low') as 'Low' | 'Medium' | 'High',
        evidence: String(f.evidence ?? '').slice(0, 150),
      }));
  } catch {
    return [];
  }
}

// ── Transcript Diff ───────────────────────────────────────────────────────────

export interface TranscriptDiffResult {
  droppedTopics: string[];
  newTopics: string[];
  toneShift: string;
  summary: string;
  phraseChanges: Array<{ before: string; after: string }>;
}

export async function semanticDiff(
  ticker: string,
  q1: string,
  q2: string,
  q1Text: string,
  q2Text: string,
): Promise<TranscriptDiffResult> {
  const systemPrompt = `You are a financial analyst comparing two earnings call transcripts for ${ticker}.

Compare ${q1} (PREVIOUS) vs ${q2} (CURRENT) management commentary.

Identify:
- droppedTopics: topics/themes management discussed in ${q1} but NOT in ${q2} (array of short phrases, max 6 items)
- newTopics: topics that appeared in ${q2} but were absent in ${q1} (array of short phrases, max 6 items)
- phraseChanges: specific phrasing that shifted in tone or wording (array of {before, after} objects, max 4 items)
- toneShift: one sentence describing overall tone change (e.g. "More defensive, less specific on guidance")
- summary: 2–3 sentences on what changed, what disappeared, and what it signals

Respond ONLY with valid JSON, no other text:
{"droppedTopics":[...],"newTopics":[...],"phraseChanges":[{"before":"...","after":"..."}],"toneShift":"...","summary":"..."}`;

  const completion = await groq().chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.1-70b-versatile',
    temperature: 0.1,
    max_tokens: 800,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `=== ${q1} ===\n${q1Text.slice(0, 4000)}\n\n=== ${q2} ===\n${q2Text.slice(0, 4000)}` },
    ],
  });

  const raw = completion.choices[0].message.content ?? '{}';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  try {
    const p = JSON.parse(jsonMatch?.[0] ?? raw);
    return {
      droppedTopics:  Array.isArray(p.droppedTopics)  ? p.droppedTopics.slice(0, 6)  : [],
      newTopics:      Array.isArray(p.newTopics)       ? p.newTopics.slice(0, 6)       : [],
      phraseChanges:  Array.isArray(p.phraseChanges)   ? p.phraseChanges.slice(0, 4)  : [],
      toneShift:      String(p.toneShift ?? ''),
      summary:        String(p.summary   ?? ''),
    };
  } catch {
    return { droppedTopics: [], newTopics: [], phraseChanges: [], toneShift: '', summary: '' };
  }
}

// ── Guidance Promise Extraction ───────────────────────────────────────────────

export interface ExtractedPromise {
  speaker: string;
  category: string;
  verbatimQuote: string;
  timeframe: string;
  confidenceScore: number;
  directLanguage: boolean;
}

const PROMISE_CATEGORIES = ['Revenue', 'Margin', 'Volume', 'Capex', 'Hiring', 'Product', 'Regulatory', 'Dividend', 'Guidance', 'Other'];

export async function extractGuidancePromises(
  ticker: string,
  quarter: string,
  transcriptText: string,
): Promise<ExtractedPromise[]> {
  const systemPrompt = `You are a financial analyst extracting forward-looking management commitments from an earnings call transcript for ${ticker} ${quarter}.

Extract every distinct forward-looking promise, target, or commitment made by management (CEO, CFO, MD, Chairman).
Focus ONLY on statements with measurable or verifiable outcomes — skip generic strategy talk.

For each promise:
- speaker: speaker name/role as it appears (e.g., "CFO", "Managing Director")
- category: one of ${PROMISE_CATEGORIES.join(', ')}
- verbatimQuote: exact verbatim quote from transcript (under 200 chars)
- timeframe: when they said it will happen (e.g., "by Q4FY26", "over next 12 months", "FY26")
- confidenceScore: 1–5 (5=very direct commitment like "we WILL", 1=extremely vague like "we aim to explore")
- directLanguage: true if they used "will", "commit", "target", "expect"; false if "hope", "aim", "try", "look to"

Return 0–10 promises as a JSON array. Return [] if no clear commitments found.
Respond ONLY with a JSON array, no other text:
[{"speaker":"...","category":"...","verbatimQuote":"...","timeframe":"...","confidenceScore":N,"directLanguage":true/false},...]`;

  const completion = await groq().chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.1-70b-versatile',
    temperature: 0.1,
    max_tokens: 1500,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: transcriptText.slice(0, 8000) },
    ],
  });

  const raw = completion.choices[0].message.content ?? '[]';
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  try {
    const parsed = JSON.parse(arrMatch?.[0] ?? raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 10).map((p: Record<string, unknown>) => ({
      speaker:         String(p.speaker ?? ''),
      category:        PROMISE_CATEGORIES.includes(String(p.category)) ? String(p.category) : 'Other',
      verbatimQuote:   String(p.verbatimQuote ?? '').slice(0, 200),
      timeframe:       String(p.timeframe ?? ''),
      confidenceScore: Math.round(Math.max(1, Math.min(5, Number(p.confidenceScore) || 3))),
      directLanguage:  Boolean(p.directLanguage),
    }));
  } catch {
    return [];
  }
}

export interface PromiseResolution {
  status: 'delivered' | 'partial' | 'missed';
  resolutionNote: string;
}

export async function resolvePromise(
  promise: { verbatimQuote: string; timeframe: string; category: string },
  newQuarterChunks: string,
  newQuarter: string,
): Promise<PromiseResolution> {
  const systemPrompt = `You are checking whether a management promise from a prior earnings call was fulfilled in a subsequent quarter.

Prior promise: "${promise.verbatimQuote}"
Timeframe promised: "${promise.timeframe}"
Category: "${promise.category}"
Checking against: ${newQuarter}

Based on the transcript excerpts below, determine if this promise was:
- delivered: explicitly confirmed with evidence (numbers, announcement, etc.)
- partial: partially addressed but not fully delivered
- missed: explicitly contradicted, delayed, or not mentioned despite timeframe having passed

resolutionNote: one sentence explaining the evidence (or lack thereof).

Respond ONLY with JSON: {"status":"delivered"|"partial"|"missed","resolutionNote":"..."}`;

  const completion = await groq().chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.1-70b-versatile',
    temperature: 0.1,
    max_tokens: 300,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: newQuarterChunks.slice(0, 4000) },
    ],
  });

  const raw = completion.choices[0].message.content ?? '{}';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(jsonMatch?.[0] ?? raw);
    const status = ['delivered', 'partial', 'missed'].includes(parsed.status)
      ? parsed.status as PromiseResolution['status']
      : 'missed';
    return { status, resolutionNote: String(parsed.resolutionNote ?? '') };
  } catch {
    return { status: 'missed', resolutionNote: '' };
  }
}

export async function scoreManagementQuality(
  ticker: string,
  quarter: string,
  mgmtText: string,
  prevQuarterText?: string,
  prevQuarterLabel?: string,
): Promise<ManagementQualityScore> {
  const hasPrev = !!(prevQuarterText?.trim());

  const userContent = hasPrev
    ? `=== ${prevQuarterLabel} management statements (PREVIOUS quarter) ===\n${prevQuarterText}\n\n=== ${quarter} management statements (CURRENT quarter) ===\n${mgmtText}`
    : `=== ${quarter} management statements ===\n${mgmtText}`;

  const systemPrompt = `You are evaluating management communication quality in earnings calls for ${ticker}.

Score each dimension 0–100 (realistic range 30–85):
- confidence: Assertive clear commitments vs hedged language. High = "we will", "we have delivered". Low = "we hope", "we expect to try", "subject to".
- transparency: Specific numbers and explanations vs platitudes. High = concrete targets with timeframes. Low = vague statements like "we are focused on growth".
- followThrough: ${hasPrev ? 'Did current quarter explicitly address prior commitments with data? High = addressed with numbers. Low = ignored. 50 = neutral.' : 'Set to 50 — no prior quarter provided.'}

Extract:
- hedgeWords: up to 5 actual hedging phrases found verbatim in CURRENT quarter text
- prevPromises: ${hasPrev ? 'up to 3 short verbatim forward-looking commitments from PREVIOUS quarter text' : 'empty array'}
- deliveryNote: ${hasPrev ? 'one sentence on whether current quarter addressed prior promises' : 'empty string'}
- summary: one sentence on overall management quality this quarter

Respond ONLY with valid JSON, no other text:
{"confidence":N,"transparency":N,"followThrough":N,"summary":"...","hedgeWords":[...],"prevPromises":[...],"deliveryNote":"..."}`;

  const completion = await groq().chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.1-70b-versatile',
    temperature: 0.1,
    max_tokens: 600,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userContent },
    ],
  });

  const raw        = completion.choices[0].message.content ?? '{}';
  const jsonMatch  = raw.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(jsonMatch?.[0] ?? raw);
    return {
      confidence:    clamp(parsed.confidence),
      transparency:  clamp(parsed.transparency),
      followThrough: clamp(parsed.followThrough),
      summary:       String(parsed.summary ?? ''),
      hedgeWords:    Array.isArray(parsed.hedgeWords)   ? parsed.hedgeWords.slice(0, 5)   : [],
      prevPromises:  Array.isArray(parsed.prevPromises) ? parsed.prevPromises.slice(0, 3) : [],
      deliveryNote:  String(parsed.deliveryNote ?? ''),
    };
  } catch {
    return { confidence: 50, transparency: 50, followThrough: 50, summary: '', hedgeWords: [], prevPromises: [], deliveryNote: '' };
  }
}
