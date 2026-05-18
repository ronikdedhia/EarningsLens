const TOKEN   = process.env.TELEGRAM_ACCESS_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API     = `https://api.telegram.org/bot${TOKEN}`;

// Fire-and-forget — call without await so it never blocks a response
export function notify(message: string): void {
  if (!TOKEN || !CHAT_ID) return;
  fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' }),
  }).catch(() => {});
}

// Blocking version for scripts that need confirmation
export async function notifyAsync(message: string): Promise<void> {
  if (!TOKEN || !CHAT_ID) return;
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' }),
  });
}
