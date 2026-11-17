const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_ACCESS_TOKEN}`;

// Telegram rejects messages longer than 4096 characters.
export const TELEGRAM_MAX = 4096;

let _telegramsSent = 0;
export function getTelegramCount() { return _telegramsSent; }
export function resetTelegramCount() { _telegramsSent = 0; }

/**
 * Escapes text for parse_mode=HTML. Messages used to go out as legacy Markdown
 * with raw filing titles and LLM summaries inside, and a single `_`, `*` or `[`
 * in that text made Telegram reject the whole message with 400 "can't parse
 * entities". Nothing checked the response, so those digests vanished silently.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Splits on line boundaries so no part exceeds `max`. A single line longer
 * than `max` is cut hard (callers only put escaped text in long lines).
 */
export function splitMessage(message: string, max = TELEGRAM_MAX): string[] {
  if (message.length <= max) return [message];
  const parts: string[] = [];
  let current = '';
  for (const line of message.split('\n')) {
    const pieces: string[] = [];
    for (let i = 0; i < Math.max(line.length, 1); i += max) pieces.push(line.slice(i, i + max));
    for (const piece of pieces) {
      const candidate = current ? `${current}\n${piece}` : piece;
      if (candidate.length > max) {
        if (current) parts.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current) parts.push(current);
  return parts;
}

interface TelegramResponse {
  ok:           boolean;
  description?: string;
  parameters?:  { retry_after?: number };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function post(body: Record<string, unknown>): Promise<{ status: number; data: TelegramResponse }> {
  const res = await fetch(`${API()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` })) as TelegramResponse;
  return { status: res.status, data };
}

/** Sends one part, honouring 429 retry_after. Throws with Telegram's own description. */
async function sendPart(chatId: string, html: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { status, data } = await post({
      chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
    });
    if (data.ok) return;

    if (status === 429) {
      const wait = (data.parameters?.retry_after ?? 2) * 1000;
      console.warn(`[telegram] rate limited, retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (status === 400 && /parse entities/i.test(data.description ?? '')) {
      // Never drop the alert over formatting: resend without parse_mode, tags stripped.
      console.error(`[telegram] HTML rejected (${data.description}); resending as plain text`);
      const plain = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const retry = await post({ chat_id: chatId, text: plain, disable_web_page_preview: true });
      if (retry.data.ok) return;
      throw new Error(`Telegram ${retry.status}: ${retry.data.description ?? 'unknown error'}`);
    }
    if (status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`Telegram ${status}: ${data.description ?? 'unknown error'}`);
  }
  throw new Error('Telegram: gave up after retries');
}

// One queue for the whole process so multi-part digests arrive in order and a
// burst of parts doesn't trip Telegram's per-chat limit.
let queue: Promise<void> = Promise.resolve();

/** Blocking send of an HTML message to the alerts chat (escape dynamic text with escapeHtml). */
export async function notifyAsync(html: string): Promise<void> {
  return sendTo(process.env.TELEGRAM_CHAT_ID, html);
}

/** Blocking send to a specific chat (bot replies). */
export async function sendTo(chatId: string | number | undefined, html: string): Promise<void> {
  const token = process.env.TELEGRAM_ACCESS_TOKEN;
  if (!token || chatId == null || chatId === '') {
    console.log(`[telegram] no token/chat — would send: ${html.slice(0, 80)}`);
    return;
  }
  const id = String(chatId);
  const parts = splitMessage(html);
  const job = queue.then(async () => {
    for (const part of parts) {
      _telegramsSent++;
      console.log(`[telegram] sending msg #${_telegramsSent}: ${part.slice(0, 80)}`);
      await sendPart(id, part);
      await sleep(350);
    }
  });
  queue = job.catch(() => {});
  return job;
}

/** Any Bot API method (setWebhook, getWebhookInfo, setMyCommands). Throws on ok:false. */
export async function telegramApi<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${API()}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json() as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  return data.result as T;
}

// Fire-and-forget — call without await so it never blocks a response. Failures are logged.
export function notify(html: string): void {
  notifyAsync(html).catch(err => console.error('[telegram] send failed:', String(err)));
}
