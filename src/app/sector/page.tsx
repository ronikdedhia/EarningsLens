import SectorPulse from '@/frontend/SectorPulse';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Sector Pulse — EarningsLens' };

export default function SectorPage() {
  return (
    <AuthGate
      feature="Sector Pulse"
      description="AI-extracted sector-wide themes and sentiment divergence across all companies in a sector — in one view."
    >
      <SectorPulse />
    </AuthGate>
  );
}
