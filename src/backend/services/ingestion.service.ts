import { Client } from '@upstash/qstash';
import { ingestGraph } from '../graphs/ingest.graph';

export interface IngestBody {
  ticker:       string;
  quarter:      string;
  fiscalYear:   number;
  publishedAt?: string;
  source?:      string;
  transcript:   string;
}

export interface IngestResult {
  message:  string;
  turns?:   number;
  chunks?:  number;
  skipped?: boolean;
  queued?:  boolean;
}

export async function runIngestion(body: IngestBody): Promise<IngestResult> {
  const state = await ingestGraph.invoke({
    ticker:      body.ticker,
    quarter:     body.quarter,
    fiscalYear:  body.fiscalYear,
    publishedAt: body.publishedAt ?? '',
    source:      body.source ?? '',
    transcript:  body.transcript,
    skipped:     false,
    points:      [],
    turns:       0,
    result:      { message: '' },
  });
  return state.result;
}

/**
 * Hands the job to QStash when it is configured (the worker route runs it),
 * otherwise runs it in-process. Callers inside the backend use this directly;
 * they used to POST to their own /api/ingest over localhost.
 */
export async function enqueueOrRunIngestion(body: IngestBody): Promise<IngestResult> {
  if (process.env.QSTASH_TOKEN && process.env.BACKEND_PUBLIC_URL) {
    const qstash = new Client({ token: process.env.QSTASH_TOKEN });
    await qstash.publishJSON({
      url:  `${process.env.BACKEND_PUBLIC_URL}/api/ingest/worker`,
      body,
    });
    return {
      message: `${body.ticker.toUpperCase()} ${body.quarter} queued — processing in background`,
      queued:  true,
    };
  }
  return runIngestion(body);
}
