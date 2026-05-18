import ManagementQuality from '@/frontend/ManagementQuality';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Management Quality — EarningsLens' };

export default function ManagementPage() {
  return (
    <AuthGate
      feature="Management Quality"
      description="AI scoring of management confidence, transparency, and follow-through across earnings quarters."
    >
      <ManagementQuality />
    </AuthGate>
  );
}
