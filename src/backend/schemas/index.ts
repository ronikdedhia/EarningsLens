import { z } from 'zod';

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

export const PROMISE_CATEGORIES = [
  'Revenue', 'Margin', 'Volume', 'Capex', 'Hiring',
  'Product', 'Regulatory', 'Dividend', 'Guidance', 'Other',
] as const;

// ── Sentiment ─────────────────────────────────────────────────────────────────

export const SentimentSchema = z.object({
  label: z.enum(['positive', 'negative', 'neutral']),
  score: z.number().min(0).max(1),
});

// ── Red Flags ─────────────────────────────────────────────────────────────────

export const RedFlagArraySchema = z.object({
  flags: z.array(z.object({
    flagType: z.enum(RED_FLAG_TYPES),
    severity: z.enum(['Low', 'Medium', 'High']),
    evidence: z.string().max(150),
  })),
});

// ── Guidance Promises ─────────────────────────────────────────────────────────

export const ExtractedPromisesSchema = z.object({
  promises: z.array(z.object({
    speaker: z.string(),
    category: z.enum(PROMISE_CATEGORIES),
    verbatimQuote: z.string().max(200),
    timeframe: z.string(),
    confidenceScore: z.number().int().min(1).max(5),
    directLanguage: z.boolean(),
  })).max(10),
});

export const PromiseResolutionSchema = z.object({
  status: z.enum(['delivered', 'partial', 'missed']),
  resolutionNote: z.string(),
});

// ── Management Quality ────────────────────────────────────────────────────────

export const ManagementQualitySchema = z.object({
  confidence:    z.number().int().min(0).max(100),
  transparency:  z.number().int().min(0).max(100),
  followThrough: z.number().int().min(0).max(100),
  summary:       z.string(),
  hedgeWords:    z.array(z.string()).max(5),
  prevPromises:  z.array(z.string()).max(3),
  deliveryNote:  z.string(),
});

// ── Sector Analysis ───────────────────────────────────────────────────────────

export const SectorAnalysisSchema = z.object({
  themes: z.array(z.object({
    theme:      z.string(),
    summary:    z.string(),
    companies:  z.array(z.string()),
    optimistic: z.array(z.string()),
    cautious:   z.array(z.string()),
  })).max(5),
  emerging: z.array(z.object({
    topic:     z.string(),
    companies: z.array(z.string()),
    context:   z.string(),
  })).max(3),
});

// ── Daily Filings ─────────────────────────────────────────────────────────────

export const FILING_CATEGORIES = [
  'earnings', 'board', 'investor_meet', 'press_release',
  'management_change', 'acquisition', 'regulatory', 'other',
] as const;

export const FilingImportanceSchema = z.object({
  isImportant:     z.boolean(),
  score:           z.number().int().min(1).max(5),
  reason:          z.string(),
  filingCategory:  z.enum(FILING_CATEGORIES),
});

export const FilingInsightsSchema = z.object({
  summary:    z.string(),
  keyPoints:  z.array(z.string()).max(5),
  sentiment:  z.enum(['positive', 'negative', 'neutral']),
  actionable: z.boolean(),
  watchFor:   z.string(),
});

// ── Transcript Diff ───────────────────────────────────────────────────────────

export const TranscriptDiffSchema = z.object({
  droppedTopics: z.array(z.string()).max(6),
  newTopics:     z.array(z.string()).max(6),
  phraseChanges: z.array(z.object({
    before: z.string(),
    after:  z.string(),
  })).max(4),
  toneShift: z.string(),
  summary:   z.string(),
});
