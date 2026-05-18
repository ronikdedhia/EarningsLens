import SentimentExplorer from '@/frontend/SentimentExplorer';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Sentiment — EarningsLens' };

export default function SentimentPage() {
  return (
    <AuthGate
      feature="Sentiment"
      description="Track signed sentiment drift across quarters using FinBERT. See when management tone shifts before earnings miss."
    >
      <SentimentExplorer />
    </AuthGate>
  );
}
