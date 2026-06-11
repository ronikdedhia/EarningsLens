import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const CURL_ARGS = (url: string) => [
  '-sL', url,
  '-H', 'Referer: https://www.bseindia.com/',
  '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  '--max-time', '30',
  '--output', '-',
];

export async function fetchPdfBuffer(url: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('curl', CURL_ARGS(url), { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 });
  if (stdout.slice(0, 4).toString() !== '%PDF') {
    throw new Error('Not a PDF (got HTML — URL expired or blocked)');
  }
  return stdout;
}

export async function fetchPdfText(url: string): Promise<string> {
  const buffer = await fetchPdfBuffer(url);
  const pdfParse = (await import('pdf-parse')).default;
  const { text } = await pdfParse(buffer);
  return text;
}
