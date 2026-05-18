import TranscriptDiff from '@/frontend/TranscriptDiff';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Quarter Diff — EarningsLens' };

export default function DiffPage() {
  return (
    <AuthGate
      feature="Quarter Diff"
      description="Side-by-side AI comparison of two earnings quarters — what disappeared, what emerged, how management tone shifted."
    >
      <TranscriptDiff />
    </AuthGate>
  );
}
