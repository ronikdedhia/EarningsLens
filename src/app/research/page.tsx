import QueryInterface from '@/frontend/QueryInterface';
import AuthGate from '@/frontend/AuthGate';

export const metadata = { title: 'Research — EarningsLens' };

export default function ResearchPage() {
  return (
    <AuthGate
      feature="Research"
      description="Ask natural-language questions across earnings call transcripts. Powered by RAG + Groq."
    >
      <QueryInterface />
    </AuthGate>
  );
}
