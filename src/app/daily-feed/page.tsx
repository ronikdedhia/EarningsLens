import DailyFeed from '@/frontend/DailyFeed';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Daily Feed — EarningsLens' };

export default function DailyFeedPage() {
  return (
    <AuthGate
      feature="Daily Feed"
      description="Daily BSE filings for tracked companies — AI-classified importance, key insights, and sentiment signals."
    >
      <DailyFeed />
    </AuthGate>
  );
}
