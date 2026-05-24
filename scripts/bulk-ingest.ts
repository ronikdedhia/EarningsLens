/**
 * Reads pending ingestions from Turso quarter_index (pdf_url set, ingested_at null)
 * and processes each one.
 *
 * Usage:
 *   1. Add rows to quarter_index with pdf_url via Turso shell or POST /api/quarters
 *   2. npm run dev
 *   3. npx tsx scripts/bulk-ingest.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pdfParse from 'pdf-parse';
import { getPendingIngestions } from '../src/backend/services/turso.service';

async function parsePdfWithLlamaParse(buffer: Buffer): Promise<string | null> {
  if (!process.env.LLAMA_CLOUD_API_KEY) return null;
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), 'transcript.pdf');
  const uploadRes = await fetch('https://api.cloud.llamaindex.ai/api/parsing/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.LLAMA_CLOUD_API_KEY}` },
    body: form,
  });
  if (!uploadRes.ok) return null;
  const { id: jobId } = await uploadRes.json() as { id: string };
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const status = await fetch(`https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}`, {
      headers: { Authorization: `Bearer ${process.env.LLAMA_CLOUD_API_KEY}` },
    }).then(r => r.json()) as { status: string };
    if (status.status === 'SUCCESS') {
      const result = await fetch(`https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}/result/markdown`, {
        headers: { Authorization: `Bearer ${process.env.LLAMA_CLOUD_API_KEY}` },
      }).then(r => r.json()) as { markdown: string };
      return result.markdown;
    }
    if (status.status === 'ERROR') return null;
  }
  return null;
}

const execFileAsync = promisify(execFile);

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const BASE_URL = `http://localhost:${process.env.BACKEND_PORT ?? '3001'}`;
const DELAY_MS = 3000;

async function fetchPdfText(url: string): Promise<string> {
  // BSE uses TLS fingerprinting — Node.js gets 404, curl does not
  const { stdout } = await execFileAsync('curl', [
    '-sL', url,
    '-H', 'Referer: https://www.bseindia.com/',
    '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--max-time', '30',
    '--output', '-',
  ], { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 });

  if (stdout.slice(0, 4).toString() !== '%PDF') {
    throw new Error(`Not a PDF — got: ${stdout.slice(0, 80).toString().replace(/\n/g, ' ')}`);
  }
  const llamaText = await parsePdfWithLlamaParse(stdout);
  if (llamaText) return llamaText;
  const { text } = await pdfParse(stdout);
  return text;
}

async function processOne(row: Awaited<ReturnType<typeof getPendingIngestions>>[0]) {
  const { ticker, quarter, fiscalYear, publishedAt, pdfUrl } = row;

  let transcript: string;
  try {
    transcript = await fetchPdfText(pdfUrl);
  } catch (e) {
    return { status: 'error' as const, detail: `PDF fetch failed: ${(e as Error).message}` };
  }

  if (transcript.trim().length < 200) {
    return { status: 'error' as const, detail: 'PDF parsed but text too short — check URL' };
  }

  const res = await fetch(`${BASE_URL}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker, quarter, fiscalYear, publishedAt, source: pdfUrl, transcript }),
  });

  const data = await res.json();
  if (!res.ok) return { status: 'error' as const, detail: data.error ?? `HTTP ${res.status}` };
  if (data.skipped) return { status: 'skipped' as const, detail: 'already ingested' };
  return { status: 'ok' as const, detail: data.message, chunks: data.chunks };
}

async function main() {
  const pending = await getPendingIngestions();

  if (!pending.length) {
    console.log('No pending ingestions. Add pdf_url to quarter_index rows in Turso and re-run.');
    return;
  }

  console.log(`\nEarningsLens — Bulk Ingest`);
  console.log(`Pending: ${pending.length} quarters\n`);

  let ok = 0, skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    process.stdout.write(`[${i + 1}/${pending.length}] ${row.ticker} ${row.quarter} ... `);

    const result = await processOne(row);
    const icon = result.status === 'ok' ? '✓' : result.status === 'skipped' ? '–' : '✗';
    const detail = 'chunks' in result ? `${result.chunks} chunks` : result.detail;
    console.log(`${icon} ${detail}`);

    if (result.status === 'ok') { ok++; await new Promise((r) => setTimeout(r, DELAY_MS)); }
    else if (result.status === 'skipped') skipped++;
    else errors.push(`${row.ticker} ${row.quarter}: ${result.detail}`);
  }

  console.log(`\n✓ ${ok}  – ${skipped}  ✗ ${errors.length}`);
  if (errors.length) { errors.forEach((e) => console.log(`  ${e}`)); process.exit(1); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
