import { Router, Request, Response } from 'express';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { embedBatch } from '../services/embedding.service';
import { upsertChunks, ensureCollection, type ChunkPayload } from '../services/qdrant.service';
import { scoreBatch } from '../services/sentiment.service';
import { isQuarterIngested, markIngested, saveSentimentScore } from '../services/turso.service';
import { parseSpeakers } from '../utils/speaker-parser';
import { notify } from '../services/telegram.service';
import { sendEmail, ingestionEmail } from '../services/email.service';
import { extractPromisesForQuarter, resolvePromisesForQuarter } from '../services/promises.service';
import { scanAndSaveRedFlags } from '../services/redflags.service';

const router = Router();
const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 512, chunkOverlap: 64 });

router.post('/', async (req: Request, res: Response) => {
  const { ticker, quarter, fiscalYear, publishedAt, source, transcript } = req.body;

  if (!ticker || !quarter || !fiscalYear || !transcript) {
    return res.status(400).json({ error: 'ticker, quarter, fiscalYear, and transcript are required' });
  }

  const t = ticker.toUpperCase();

  if (await isQuarterIngested(t, quarter)) {
    return res.json({ message: `${t} ${quarter} already ingested`, skipped: true });
  }

  await ensureCollection();

  const turns = parseSpeakers(transcript);
  const points: Parameters<typeof upsertChunks>[0] = [];
  const sentimentWrites: Promise<void>[] = [];

  for (const turn of turns) {
    const chunks = await splitter.splitText(turn.content);
    if (!chunks.length) continue;

    const [vectors, scores] = await Promise.all([embedBatch(chunks), scoreBatch(chunks)]);

    chunks.forEach((text, i) =>
      points.push({
        id: crypto.randomUUID(),
        vector: vectors[i],
        payload: {
          ticker: t, quarter, fiscalYear,
          speakerRole: turn.role as ChunkPayload['speakerRole'],
          speakerName: turn.speaker,
          topic: turn.topic,
          text, source, publishedAt,
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

  // Fire-and-forget: extract promises, resolve prior promises, scan red flags
  Promise.all([
    extractPromisesForQuarter(t, quarter),
    resolvePromisesForQuarter(t, quarter),
    scanAndSaveRedFlags(t, quarter),
  ]).catch(() => {});

  // Notify after commit
  const summary = `✅ *${t} ${quarter}* ingested\n${turns.length} speaker turns · ${points.length} chunks`;
  notify(summary);
  const { subject, html } = ingestionEmail(t, quarter, turns.length, points.length);
  sendEmail(subject, html).catch(() => {});

  return res.json({
    message: `${t} ${quarter}: ${turns.length} speaker turns, ${points.length} chunks ingested`,
    turns: turns.length,
    chunks: points.length,
  });
});

export { router as ingestRouter };
