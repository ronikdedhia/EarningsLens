import { listCompanies, getAllInsights } from './turso.service';
import { sendNewsletterEmail, weeklyInsightsEmail, type CompanyInsightGroup } from './email.service';

function istDateLabel(): string {
  const now = new Date();
  return now.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day:      'numeric',
    month:    'long',
    year:     'numeric',
  });
}

export async function sendWeeklyNewsletter(): Promise<{ sent: boolean; companies: number; insights: number }> {
  const [companies, allInsights] = await Promise.all([listCompanies(), getAllInsights()]);

  // Group insights by ticker
  const byTicker = new Map<string, typeof allInsights>();
  for (const insight of allInsights) {
    const list = byTicker.get(insight.ticker) ?? [];
    list.push(insight);
    byTicker.set(insight.ticker, list);
  }

  // Build groups — only companies that have at least one insight
  const companyMap = new Map(companies.map(c => [c.ticker, c]));
  const groups: CompanyInsightGroup[] = [];

  for (const [ticker, insights] of byTicker) {
    const company = companyMap.get(ticker);
    groups.push({
      ticker,
      name:    company?.name   ?? ticker,
      sector:  company?.sector ?? 'Unknown',
      insights: insights.map(i => ({
        title:       i.title,
        content:     i.content,
        generatedAt: i.generatedAt,
      })),
    });
  }

  // Alphabetical order by ticker
  groups.sort((a, b) => a.ticker.localeCompare(b.ticker));

  const totalInsights = groups.reduce((n, g) => n + g.insights.length, 0);
  if (!totalInsights) return { sent: false, companies: 0, insights: 0 };

  const { subject, html } = weeklyInsightsEmail(groups, istDateLabel());
  await sendNewsletterEmail(subject, html);

  return { sent: true, companies: groups.length, insights: totalInsights };
}

// Parses NEWSLETTER_SEND_TIME (HH:MM IST) → UTC cron expression for Friday
export function parseNewsletterCron(): string {
  const raw = process.env.NEWSLETTER_SEND_TIME ?? '09:00';
  const [hStr, mStr] = raw.split(':');
  const h = Math.max(0, Math.min(23, parseInt(hStr, 10) || 9));
  const m = Math.max(0, Math.min(59, parseInt(mStr, 10) || 0));
  let utcMins = h * 60 + m - 330; // subtract IST offset (5h 30m)
  if (utcMins < 0) utcMins += 1440;
  return `${utcMins % 60} ${Math.floor(utcMins / 60)} * * 5`; // Friday
}
