import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { embedBatch } from '../services/embedding.service';
import { upsertChunks, ensureCollection, type ChunkPayload } from '../services/qdrant.service';
import { scoreBatch } from '../services/sentiment.service';
import { isQuarterIngested, markIngested, saveSentimentScore } from '../services/turso.service';
import { parseSpeakers } from '../utils/speaker-parser';
import { sendEmail, ingestionEmail } from '../services/email.service';
import { extractPromisesForQuarter, resolvePromisesForQuarter } from '../services/promises.service';
import { scanAndSaveRedFlags } from '../services/redflags.service';

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 512, chunkOverlap: 64 });

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

  await ensureCollection();

  const speakerTurns = parseSpeakers(transcript);
  const points: UpsertPoint[] = [];
  const sentimentWrites: Promise<void>[] = [];

  for (const turn of speakerTurns) {
    const chunks = await splitter.splitText(turn.content);
    if (!chunks.length) continue;

    const [vectors, scores] = await Promise.all([
      embedBatch(chunks),
      scoreBatch(chunks),
    ]);

    chunks.forEach((text: string, i: number) =>
      points.push({
        id:     crypto.randomUUID(),
        vector: vectors[i],
        payload: {
          ticker: t, quarter, fiscalYear,
          speakerRole: turn.role as ChunkPayload['speakerRole'],
          speakerName: turn.speaker,
          topic:       turn.topic,
          text,
          source:      source ?? '',
          publishedAt: publishedAt ?? '',
        } satisfies ChunkPayload,
      })
    );

    const avg = scores.reduce((s, r) => s + r.score, 0) / scores.length;
    const labelCount = scores.reduce((acc, r) => {
      acc[r.label] = (acc[r.label] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const topLabel = Object.entries(labelCount).sort((a, b) => b[1] - a[1])[0][0];
    sentimentWrites.push(saveSentimentScore(t, quarter, turn.topic, topLabel, avg));
  }

  await upsertChunks(points);
  await Promise.all([markIngested(t, quarter), ...sentimentWrites]);

  // fire-and-forget: async analysis
  Promise.all([
    extractPromisesForQuarter(t, quarter),
    resolvePromisesForQuarter(t, quarter),
    scanAndSaveRedFlags(t, quarter),
  ]).catch(() => {});

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
