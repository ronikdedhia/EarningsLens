import Scorecard from '@/frontend/Scorecard';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Scorecard — EarningsLens' };

export default function ScorecardPage() {
  return (
    <AuthGate
      feature="Scorecard"
      description="Quarterly numbers with QoQ/YoY, insider and deal activity, and how prices moved after filings, red flags and signals."
    >
      <Scorecard />
    </AuthGate>
  );
}
