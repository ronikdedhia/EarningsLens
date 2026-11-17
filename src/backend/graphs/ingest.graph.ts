import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { embedBatch } from '../services/embedding.service';
import { upsertChunks, ensureCollection, deleteQuarterChunks, type ChunkPayload } from '../services/qdrant.service';
import { scoreBatch } from '../services/sentiment.service';
import { isQuarterIngested, markIngested, saveSentimentScore } from '../services/turso.service';
import { parseSpeakers } from '../utils/speaker-parser';
import { sendEmail, ingestionEmail } from '../services/email.service';
import { extractPromisesForQuarter, resolvePromisesForQuarter } from '../services/promises.service';
import { scanAndSaveRedFlags } from '../services/redflags.service';

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 512, chunkOverlap: 64 });

// Promise extraction and red-flag scans run after the ingest returns. Scripts
// must wait for them before process.exit(), or the work is killed half-way.
const background = new Set<Promise<void>>();
function trackBackground(p: Promise<void>): void {
  background.add(p);
  p.finally(() => background.delete(p));
}
export async function waitForBackgroundAnalysis(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
}
// ~64 chunks ≈ 8K tokens, under the Voyage free tier's 10K tokens/minute per request
const EMBED_BATCH = 64;

// ── State ─────────────────────────────────────────────────────────────────────

type UpsertPoint = Parameters<typeof upsertChunks>[0][number];

const IngestAnnotation = Annotation.Root({
  ticker:      Annotation<string>,
  quarter:     Annotation<string>,
  fiscalYear:  Annotation<number>,
  publishedAt: Annotation<string>,
  source:      Annotation<string>,
  transcript:  Annotation<string>,
  // intermediate
  skipped: Annotation<boolean>,
  points:  Annotation<UpsertPoint[]>,
  turns:   Annotation<number>,
  // output
  result: Annotation<{ message: string; turns?: number; chunks?: number; skipped?: boolean }>,
});

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function checkIngestedNode(state: typeof IngestAnnotation.State) {
  const t = state.ticker.toUpperCase();
  const alreadyDone = await isQuarterIngested(t, state.quarter);
  return { skipped: alreadyDone };
}

async function processTranscriptNode(state: typeof IngestAnnotation.State) {
  const { ticker: raw, quarter, fiscalYear, publishedAt, source, transcript } = state;
  const t = raw.toUpperCase();

  const speakerTurns = parseSpeakers(transcript);

  // Flatten to chunks first so embedding and sentiment run in a few batched
  // calls instead of one burst of calls per speaker turn.
  const items: Array<{ turnIdx: number; text: string; section: 'prepared' | 'qa' }> = [];
  let section: 'prepared' | 'qa' = 'prepared';
  for (let turnIdx = 0; turnIdx < speakerTurns.length; turnIdx++) {
    const turn = speakerTurns[turnIdx];
    if (turn.role === 'Analyst') section = 'qa';
    for (const text of await splitter.splitText(turn.content)) {
      items.push({ turnIdx, text, section });
    }
  }
  if (!items.length) throw new Error(`${t} ${quarter}: transcript produced no chunks`);

  const texts = items.map(i => i.text);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    vectors.push(...await embedBatch(texts.slice(i, i + EMBED_BATCH)));
  }
  await ensureCollection(vectors[0].length);
  await deleteQuarterChunks(t, quarter); // leftovers from an interrupted run
  const scores = await scoreBatch(texts);

  const points: UpsertPoint[] = items.map((item, i) => {
    const turn = speakerTurns[item.turnIdx];
    return {
      id:     crypto.randomUUID(),
      vector: vectors[i],
      payload: {
        ticker: t, quarter, fiscalYear,
        speakerRole: turn.role as ChunkPayload['speakerRole'],
        speakerName: turn.speaker,
        topic:       turn.topic,
        text:        item.text,
        source:      source ?? '',
        publishedAt: publishedAt ?? '',
        chunkIndex:  i,
        section:     item.section,
      } satisfies ChunkPayload,
    };
  });

  // One sentiment row per speaker turn, as before.
  const sentimentWrites: Promise<void>[] = [];
  for (let turnIdx = 0; turnIdx < speakerTurns.length; turnIdx++) {
    const turnScores = scores.filter((_, i) => items[i].turnIdx === turnIdx);
    if (!turnScores.length) continue;
    const avg = turnScores.reduce((s, r) => s + r.score, 0) / turnScores.length;
    const labelCount = turnScores.reduce((acc, r) => {
      acc[r.label] = (acc[r.label] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const topLabel = Object.entries(labelCount).sort((a, b) => b[1] - a[1])[0][0];
    sentimentWrites.push(saveSentimentScore(t, quarter, speakerTurns[turnIdx].topic, topLabel, avg));
  }

  await upsertChunks(points);
  await Promise.all([markIngested(t, quarter), ...sentimentWrites]);

  // Background analysis. Extraction runs before resolution so this quarter's own
  // promises are never resolved against itself.
  trackBackground((async () => {
    await extractPromisesForQuarter(t, quarter)
      .catch(err => console.error(`[ingest] promise extraction ${t} ${quarter}:`, String(err).slice(0, 200)));
    await resolvePromisesForQuarter(t, quarter)
      .catch(err => console.error(`[ingest] promise resolution ${t} ${quarter}:`, String(err).slice(0, 200)));
    await scanAndSaveRedFlags(t, quarter)
      .catch(err => console.error(`[ingest] red flags ${t} ${quarter}:`, String(err).slice(0, 200)));
  })());

  const { subject, html } = ingestionEmail(t, state.quarter, speakerTurns.length, points.length);
  sendEmail(subject, html).catch(() => {});

  return {
    turns:  speakerTurns.length,
    points,
    result: {
      message: `${t} ${state.quarter}: ${speakerTurns.length} speaker turns, ${points.length} chunks ingested`,
      turns:   speakerTurns.length,
      chunks:  points.length,
    },
  };
}

function alreadyIngestedNode(state: typeof IngestAnnotation.State) {
  return {
    result: {
      message: `${state.ticker.toUpperCase()} ${state.quarter} already ingested`,
      skipped: true,
    },
  };
}

// ── Graph ─────────────────────────────────────────────────────────────────────

const workflow = new StateGraph(IngestAnnotation)
  .addNode('check',    checkIngestedNode)
  .addNode('process',  processTranscriptNode)
  .addNode('skip',     alreadyIngestedNode)
  .addEdge(START, 'check')
  .addConditionalEdges('check',
    state => state.skipped ? 'skip' : 'process',
    { skip: 'skip', process: 'process' }
  )
  .addEdge('process', END)
  .addEdge('skip',    END);

export const ingestGraph = workflow.compile();
