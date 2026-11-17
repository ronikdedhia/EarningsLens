import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import {
  RED_FLAG_TYPES,
  PROMISE_CATEGORIES,
  RedFlagArraySchema,
  ExtractedPromisesSchema,
  PromiseResolutionSchema,
  ManagementQualitySchema,
  SectorAnalysisSchema,
  TranscriptDiffSchema,
  TranscriptDigestSchema,
} from '../schemas';
import { chatModel, withLlmSlot, DailyLimitError } from './llm';
import { mergeRedFlags, dedupePromises } from '../utils/transcript';

function model(temperature = 0.1, maxTokens = 1024) {
  return chatModel('main', { temperature, maxTokens });
}

/**
 * Runs `fn` over every window. A failed window is logged and skipped; if every
 * window fails the error is thrown, so callers never store "nothing found" for
 * what was really an API outage.
 */
async function mapWindows<T>(label: string, windows: string[], fn: (w: string, i: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  let failures = 0;
  let lastError: unknown;
  for (let i = 0; i < windows.length; i++) {
    try {
      out.push(...await fn(windows[i], i));
    } catch (err) {
      // Out of daily quota: store nothing, so the catch-up job redoes the whole quarter
      // instead of keeping a result built from half the transcript.
      if (err instanceof DailyLimitError) throw err;
      failures++;
      lastError = err;
      console.error(`[${label}] window ${i + 1}/${windows.length} failed:`, String(err).slice(0, 200));
    }
  }
  if (windows.length && failures === windows.length) {
    throw new Error(`${label}: all ${failures} windows failed — ${String((lastError as Error)?.message ?? lastError)}`);
  }
  return out;
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM = `You are a financial analyst assistant specializing in earnings call analysis.
Answer questions using ONLY the provided transcript excerpts.
Always cite the specific ticker, quarter, and speaker role (CEO/CFO).
If the context is insufficient, say so — do not infer or fabricate financial data.`;

export async function synthesize(query: string, context: string): Promise<string> {
  const chain = model(0.1, 1024).pipe(new StringOutputParser());
  return withLlmSlot(() => chain.invoke([
    new SystemMessage(SYNTHESIS_SYSTEM),
    new HumanMessage(`Transcript context:\n\n${context}\n\n---\n\nQuestion: ${query}`),
  ]));
}

// ── Red Flag Scanner ──────────────────────────────────────────────────────────

type RedFlagType = typeof RED_FLAG_TYPES[number];

export interface DetectedRedFlag {
  flagType: RedFlagType;
  severity: 'Low' | 'Medium' | 'High';
  evidence: string;
}

/**
 * Scans every window of the transcript (the old code read only the first 10,000
 * characters, which never reached the Q&A where deflection and pushback happen)
 * and keeps the most severe occurrence of each flag type.
 */
export async function scanRedFlags(
  ticker: string,
  quarter: string,
  windows: string[],
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

For each flag FOUND: flagType (exact key), severity ("Low"|"Medium"|"High"), evidence (verbatim quote under 150 chars).
Return empty flags array if none found.`;

  const structured = model(0.1, 1200).withStructuredOutput(RedFlagArraySchema);
  const flags = await mapWindows('redflags', windows, async (text, i) => {
    const result = await withLlmSlot(() => structured.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Transcript part ${i + 1} of ${windows.length}:\n\n${text}`),
    ]));
    return result.flags.map(f => ({
      flagType: f.flagType as RedFlagType,
      severity: f.severity,
      evidence: f.evidence.slice(0, 150),
    }));
  });
  return mergeRedFlags(flags);
}

// ── Guidance Promise Extraction ───────────────────────────────────────────────

interface ExtractedPromise {
  speaker:         string;
  category:        string;
  verbatimQuote:   string;
  timeframe:       string;
  confidenceScore: number;
  directLanguage:  boolean;
}

/** "margins", "Revenue growth", "EBITDA" → a PROMISE_CATEGORIES value. */
export function normalizeCategory(raw: string): string {
  const s = raw.trim().toLowerCase();
  const exact = PROMISE_CATEGORIES.find(c => c.toLowerCase() === s);
  if (exact) return exact;
  const rules: Array<[RegExp, string]> = [
    [/margin|ebitda|profitab/, 'Margin'], [/revenue|sales|top.?line|growth/, 'Revenue'],
    [/volume|capacity|utili[sz]ation|order/, 'Volume'], [/capex|capital exp|investment|plant/, 'Capex'],
    [/hir|headcount|employee/, 'Hiring'], [/product|launch|pipeline|approval/, 'Product'],
    [/regulat|usfda|fda|compliance/, 'Regulatory'], [/dividend|payout|buyback/, 'Dividend'],
    [/guidance|outlook|target/, 'Guidance'],
  ];
  return rules.find(([re]) => re.test(s))?.[1] ?? 'Other';
}

/** Extracts from every window of management text, then drops repeated quotes. */
export async function extractGuidancePromises(
  ticker: string,
  quarter: string,
  windows: string[],
): Promise<ExtractedPromise[]> {
  const systemPrompt = `You are a financial analyst extracting forward-looking management commitments from an earnings call transcript for ${ticker} ${quarter}.

Extract every distinct forward-looking promise, target, or commitment made by management (CEO, CFO, MD, Chairman).
Focus ONLY on statements with measurable or verifiable outcomes — skip generic strategy talk.

For each promise:
- speaker: speaker name/role as it appears
- category: one of ${PROMISE_CATEGORIES.join(', ')}
- verbatimQuote: exact verbatim quote from transcript (under 200 chars)
- timeframe: when they said it will happen (e.g., "by Q4FY26", "over next 12 months")
- confidenceScore: 1–5 (5=very direct "we WILL", 1=extremely vague "we aim to explore")
- directLanguage: true if "will/commit/target/expect"; false if "hope/aim/try/look to"

Return 0–10 promises. Return empty promises array if no clear commitments found.`;

  const structured = model(0.1, 1500).withStructuredOutput(ExtractedPromisesSchema);
  const promises = await mapWindows('promises', windows, async (text, i) => {
    const result = await withLlmSlot(() => structured.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Management remarks, part ${i + 1} of ${windows.length}:\n\n${text}`),
    ]));
    return result.promises.slice(0, 10).map(p => ({
      speaker:         p.speaker,
      category:        normalizeCategory(p.category),
      verbatimQuote:   p.verbatimQuote.slice(0, 200),
      timeframe:       p.timeframe,
      confidenceScore: p.confidenceScore,
      directLanguage:  p.directLanguage,
    }));
  });
  return dedupePromises(promises);
}

// ── Promise Resolution ────────────────────────────────────────────────────────

export interface PromiseResolution {
  status:         'delivered' | 'partial' | 'missed' | 'pending';
  resolutionNote: string;
}

export async function resolvePromise(
  promise: { verbatimQuote: string; timeframe: string; category: string },
  newQuarterChunks: string,
  newQuarter: string,
): Promise<PromiseResolution> {
  const systemPrompt = `You are checking whether a management promise from a prior earnings call was fulfilled.

Prior promise: "${promise.verbatimQuote}"
Timeframe promised: "${promise.timeframe}"
Category: "${promise.category}"
Checking against: ${newQuarter}

Based on transcript excerpts below, determine if this promise was:
- delivered: explicitly confirmed with evidence
- partial: partially addressed but not fully delivered
- missed: contradicted, delayed, or unmentioned even though the promised timeframe has passed by ${newQuarter}
- pending: the timeframe has not passed yet and the excerpts do not settle it either way

resolutionNote: one sentence explaining the evidence (or lack thereof).`;

  // Errors propagate. The old catch returned 'missed', so a Groq outage marked
  // promises as broken and dragged down management scores.
  const structured = model(0.1, 300).withStructuredOutput(PromiseResolutionSchema);
  return withLlmSlot(() => structured.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(newQuarterChunks.slice(0, 12000)),
  ])) as Promise<PromiseResolution>;
}

// ── Management Quality Scoring ────────────────────────────────────────────────

interface ManagementQualityScore {
  confidence:    number;
  transparency:  number;
  followThrough: number;
  summary:       string;
  hedgeWords:    string[];
  prevPromises:  string[];
  deliveryNote:  string;
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
    ? `=== ${prevQuarterLabel} management statements (PREVIOUS) ===\n${prevQuarterText}\n\n=== ${quarter} management statements (CURRENT) ===\n${mgmtText}`
    : `=== ${quarter} management statements ===\n${mgmtText}`;

  const systemPrompt = `You are evaluating management communication quality in earnings calls for ${ticker}.

Score each dimension 0–100 (realistic range 30–85):
- confidence: Assertive clear commitments vs hedged language. High = "we will", "we have delivered". Low = "we hope", "we expect to try".
- transparency: Specific numbers and explanations vs platitudes. High = concrete targets with timeframes.
- followThrough: ${hasPrev ? 'Did current quarter address prior commitments? High = addressed with numbers. 50 = neutral.' : 'Set to 50 — no prior quarter provided.'}

Extract:
- hedgeWords: up to 5 actual hedging phrases verbatim from CURRENT quarter
- prevPromises: ${hasPrev ? 'up to 3 short verbatim forward-looking commitments from PREVIOUS quarter' : 'empty array'}
- deliveryNote: ${hasPrev ? 'one sentence on whether current quarter addressed prior promises' : 'empty string'}
- summary: one sentence on overall management quality this quarter`;

  // Errors propagate. The old catch returned 50/50/50, which was then saved as
  // that quarter's real score.
  const structured = model(0.1, 600).withStructuredOutput(ManagementQualitySchema);
  const result = await withLlmSlot(() => structured.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userContent),
  ]));
  const clamp = (n: number) => Math.round(Math.max(0, Math.min(100, n)));
  return {
    confidence:    clamp(result.confidence),
    transparency:  clamp(result.transparency),
    followThrough: clamp(result.followThrough),
    summary:       result.summary,
    hedgeWords:    result.hedgeWords,
    prevPromises:  result.prevPromises,
    deliveryNote:  result.deliveryNote,
  };
}

// ── Sector Narrative Extraction ───────────────────────────────────────────────

interface SectorThemeResult {
  theme:      string;
  summary:    string;
  companies:  string[];
  optimistic: string[];
  cautious:   string[];
}

interface SectorEmergingResult {
  topic:     string;
  companies: string[];
  context:   string;
}

export interface SectorAnalysisResult {
  themes:   SectorThemeResult[];
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
- theme: short name (3–5 words, e.g. "NIM compression")
- summary: one sentence on what's happening across the sector
- companies: which tickers discuss this theme
- optimistic: tickers whose management sounds positive/confident
- cautious: tickers whose management sounds worried/defensive${prevContext}

Also identify up to 3 emerging topics — themes present NOW that did NOT appear in older quarters.
- topic: short name
- companies: which tickers raise this topic
- context: one sentence on why it's new/significant`;

  try {
    const structured = model(0.15, 1200).withStructuredOutput(SectorAnalysisSchema);
    const result = await withLlmSlot(() => structured.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(context),
    ]));
    const validTickers = new Set(tickers);
    const filterTickers = (arr: string[]) => arr.filter(t => validTickers.has(t));
    return {
      themes: result.themes.map(t => ({
        theme:      t.theme,
        summary:    t.summary,
        companies:  filterTickers(t.companies),
        optimistic: filterTickers(t.optimistic),
        cautious:   filterTickers(t.cautious),
      })),
      emerging: result.emerging.map(e => ({
        topic:     e.topic,
        companies: filterTickers(e.companies),
        context:   e.context,
      })),
    };
  } catch {
    return { themes: [], emerging: [] };
  }
}

// ── Transcript Diff ───────────────────────────────────────────────────────────

export interface TranscriptDiffResult {
  droppedTopics: string[];
  newTopics:     string[];
  toneShift:     string;
  summary:       string;
  phraseChanges: Array<{ before: string; after: string }>;
}

/**
 * Map step for the diff: condenses one quarter's full transcript into a topic
 * list. The diff then compares two digests instead of the first 4,000 characters
 * of each quarter.
 */
export async function digestTranscript(ticker: string, quarter: string, windows: string[]): Promise<string> {
  const systemPrompt = `You are summarising part of the ${ticker} ${quarter} earnings call.
List the distinct business topics discussed in this part (up to 8). For each give:
- topic: 2–6 word name (e.g. "export order book", "API price erosion")
- stance: one short sentence on what management said, keeping numbers and hedging words as spoken`;

  const structured = chatModel('fast', { temperature: 0, maxTokens: 700 }).withStructuredOutput(TranscriptDigestSchema);
  const topics = await mapWindows('digest', windows, async (text, i) => {
    const result = await withLlmSlot(() => structured.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Part ${i + 1} of ${windows.length}:\n\n${text}`),
    ]));
    return result.topics.slice(0, 8);
  });
  return topics.map(t => `- ${t.topic}: ${t.stance}`).join('\n');
}

export async function semanticDiff(
  ticker: string,
  q1: string,
  q2: string,
  q1Digest: string,
  q2Digest: string,
): Promise<TranscriptDiffResult> {
  const systemPrompt = `You are a financial analyst comparing two earnings call transcripts for ${ticker}.
Each quarter is given as a topic digest covering the whole call (topic: what management said).

Compare ${q1} (PREVIOUS) vs ${q2} (CURRENT) management commentary.

Identify:
- droppedTopics: topics discussed in ${q1} but NOT in ${q2} (max 6 short phrases)
- newTopics: topics in ${q2} absent in ${q1} (max 6 short phrases)
- phraseChanges: specific phrasing that shifted in tone or wording (max 4 {before, after} objects)
- toneShift: one sentence describing overall tone change
- summary: 2–3 sentences on what changed, what disappeared, and what it signals`;

  try {
    const structured = model(0.1, 800).withStructuredOutput(TranscriptDiffSchema);
    const result = await withLlmSlot(() => structured.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`=== ${q1} ===\n${q1Digest.slice(0, 20000)}\n\n=== ${q2} ===\n${q2Digest.slice(0, 20000)}`),
    ]));
    return {
      droppedTopics: result.droppedTopics,
      newTopics:     result.newTopics,
      phraseChanges: result.phraseChanges,
      toneShift:     result.toneShift,
      summary:       result.summary,
    };
  } catch (err) {
    console.error('[diff] semantic diff failed:', String(err).slice(0, 200));
    return { droppedTopics: [], newTopics: [], phraseChanges: [], toneShift: '', summary: '' };
  }
}
