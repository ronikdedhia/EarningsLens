import ManageCompanies from '@/frontend/ManageCompanies';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Coverage — EarningsLens' };

export default function PipelinePage() {
  return (
    <AuthGate
      feature="Coverage"
      description="Add companies to your coverage universe. EarningsLens auto-discovers and ingests BSE earnings call PDFs. Free accounts can track up to 2 companies."
    >
      <ManageCompanies />
    </AuthGate>
  );
}
