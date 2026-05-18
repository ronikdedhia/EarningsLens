import RedFlagScanner from '@/frontend/RedFlagScanner';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Red Flag Scanner — EarningsLens' };

export default function RedFlagsPage() {
  return (
    <AuthGate
      feature="Red Flag Scanner"
      description="AI-powered qualitative risk detection across earnings call transcripts — language signals that financials don't show."
    >
      <RedFlagScanner />
    </AuthGate>
  );
}
