const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_ACCESS_TOKEN}`;

let _telegramsSent = 0;
export function getTelegramCount() { return _telegramsSent; }
export function resetTelegramCount() { _telegramsSent = 0; }

// Fire-and-forget — call without await so it never blocks a response
export function notify(message: string): void {
  const token  = process.env.TELEGRAM_ACCESS_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log(`[telegram] no token/chat — would send: ${message.slice(0, 80)}`);
    return;
  }
  _telegramsSent++;
  console.log(`[telegram] sending msg #${_telegramsSent}: ${message.slice(0, 80)}`);
  fetch(`${API()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
  }).catch((err) => console.error('[telegram] send failed:', String(err)));
}

// Blocking version for scripts that need confirmation
export async function notifyAsync(message: string): Promise<void> {
  const token  = process.env.TELEGRAM_ACCESS_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`${API()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
  });
}
