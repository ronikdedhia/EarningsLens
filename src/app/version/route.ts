import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Public deploy check (npm run check-deploy): which commit Vercel is serving.
export function GET() {
  return NextResponse.json({
    service: 'frontend',
    commit:  process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    env:     process.env.VERCEL_ENV ?? null,
    apiUrl:  process.env.NEXT_PUBLIC_API_URL ?? null,
  });
}
