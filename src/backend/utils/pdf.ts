import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function referer(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (/nseindia\.(com|in)$/.test(host)) return 'https://www.nseindia.com/';
  } catch { /* fall through */ }
  return 'https://www.bseindia.com/';
}

export const CURL_ARGS = (url: string) => [
  '-sL',
  '--proto', '=https,http',
  '-H', `Referer: ${referer(url)}`,
  '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  '--max-time', '30',
  '--output', '-',
  // URL last, after "--", so a value starting with "-" can never be read as a curl option
  '--', url,
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
