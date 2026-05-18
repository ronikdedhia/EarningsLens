import KeywordTracker from '@/frontend/KeywordTracker';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Keywords — EarningsLens' };

export default function KeywordsPage() {
  return (
    <AuthGate
      feature="Keywords"
      description="Track keyword and phrase frequency across all ingested earnings calls. Spot emerging themes early."
    >
      <KeywordTracker />
    </AuthGate>
  );
}
