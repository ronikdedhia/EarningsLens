import GuidancePromises from '@/frontend/GuidancePromises';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Guidance Promises — EarningsLens' };

export default function PromisesPage() {
  return (
    <AuthGate
      feature="Guidance Promises"
      description="AI-extracted management commitments tracked across quarters — see what was promised and what was delivered."
    >
      <GuidancePromises />
    </AuthGate>
  );
}
