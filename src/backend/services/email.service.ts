const API_KEY    = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? 'noreply@earningslens.app';
const FROM_NAME  = process.env.BREVO_FROM_NAME  ?? 'EarningsLens';
const TO_EMAIL   = process.env.NOTIFICATION_EMAIL;

export async function sendEmail(subject: string, html: string): Promise<void> {
  if (!API_KEY || !TO_EMAIL) return;
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: FROM_EMAIL, name: FROM_NAME },
      to: [{ email: TO_EMAIL }],
      subject,
      htmlContent: html,
    }),
  });
}

// ── Email templates ───────────────────────────────────────────────────────────

function base(body: string): string {
  return `
<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;
            background:#0f1117;color:#e2e8f0;padding:32px;border-radius:12px;">
  <h1 style="color:#f59e0b;margin:0 0 4px;font-size:18px;font-weight:700;">EarningsLens</h1>
  <p style="color:#475569;margin:0 0 28px;font-size:12px;text-transform:uppercase;
            letter-spacing:.08em;">NSE Earnings Intelligence</p>
  ${body}
  <p style="color:#1e293b;font-size:11px;margin-top:32px;border-top:1px solid #1e293b;
            padding-top:16px;">EarningsLens · automated notification</p>
</div>`;
}

function row(label: string, value: string, highlight = false): string {
  const color = highlight ? '#34d399' : '#e2e8f0';
  return `<tr>
    <td style="padding:8px 16px 8px 0;color:#64748b;font-size:13px;">${label}</td>
    <td style="padding:8px 0;color:${color};font-weight:600;font-size:13px;">${value}</td>
  </tr>`;
}

export function ingestionEmail(
  ticker: string, quarter: string, turns: number, chunks: number
): { subject: string; html: string } {
  return {
    subject: `[EarningsLens] ${ticker} ${quarter} ingested`,
    html: base(`
      <p style="color:#94a3b8;margin:0 0 16px;font-size:14px;">Ingestion complete</p>
      <table style="width:100%;border-collapse:collapse;">
        ${row('Company', ticker)}
        ${row('Quarter', quarter)}
        ${row('Speaker turns', String(turns), true)}
        ${row('Chunks embedded', String(chunks), true)}
      </table>`),
  };
}

export function insightsEmail(
  ticker: string,
  insights: Array<{ title: string; content: string }>
): { subject: string; html: string } {
  const blocks = insights.map(i => `
    <div style="margin-bottom:14px;padding:12px 16px;background:#1e293b;border-radius:8px;border-left:3px solid #f59e0b;">
      <p style="color:#f59e0b;font-weight:600;font-size:13px;margin:0 0 5px;">${i.title}</p>
      <p style="color:#94a3b8;font-size:13px;margin:0;line-height:1.6;">
        ${i.content.slice(0, 280)}${i.content.length > 280 ? '…' : ''}
      </p>
    </div>`).join('');
  return {
    subject: `[EarningsLens] AI Insights — ${ticker}`,
    html: base(`
      <p style="color:#94a3b8;margin:0 0 16px;font-size:14px;">
        New AI insights generated for <strong style="color:#f59e0b">${ticker}</strong>
      </p>
      ${blocks}`),
  };
}

export function queryEmail(
  query: string, answer: string, ticker?: string
): { subject: string; html: string } {
  return {
    subject: `[EarningsLens] Research${ticker ? ` — ${ticker}` : ''}`,
    html: base(`
      ${ticker ? `<p style="color:#f59e0b;font-weight:600;font-size:13px;margin:0 0 14px;">${ticker}</p>` : ''}
      <div style="background:#1e293b;border-radius:8px;padding:12px 16px;margin-bottom:14px;">
        <p style="color:#475569;font-size:11px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.06em;">Query</p>
        <p style="color:#e2e8f0;font-size:14px;margin:0;font-weight:500;">${query}</p>
      </div>
      <div style="background:#0f172a;border-radius:8px;padding:12px 16px;border:1px solid #1e293b;">
        <p style="color:#475569;font-size:11px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.06em;">Answer</p>
        <p style="color:#94a3b8;font-size:13px;margin:0;line-height:1.7;">
          ${answer.slice(0, 600)}${answer.length > 600 ? '…' : ''}
        </p>
      </div>`),
  };
}

export function discoveryEmail(
  ticker: string, found: number, quarters: string[]
): { subject: string; html: string } {
  return {
    subject: `[EarningsLens] ${ticker} — ${found} PDF${found !== 1 ? 's' : ''} queued`,
    html: base(`
      <p style="color:#94a3b8;margin:0 0 16px;font-size:14px;">BSE PDF auto-discovery complete</p>
      <table style="width:100%;border-collapse:collapse;">
        ${row('Company', ticker)}
        ${row('PDFs found', String(found), found > 0)}
        ${row('Quarters queued', quarters.join(', '))}
      </table>`),
  };
}
