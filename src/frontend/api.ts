'use client';

// Clerk's browser SDK exposes the active session on window.Clerk once
// <ClerkProvider> has loaded, which lets one helper attach the token for every
// component without threading useAuth() through each of them.
type ClerkGlobal = { session?: { getToken: () => Promise<string | null> } | null };

async function sessionToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const clerk = (window as unknown as { Clerk?: ClerkGlobal }).Clerk;
  try {
    return (await clerk?.session?.getToken()) ?? null;
  } catch {
    return null;
  }
}

/**
 * fetch() plus the Clerk session token. The backend now rejects unauthenticated
 * calls to everything except a few public read routes (see backend middleware/auth.ts).
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await sessionToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
