import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '@clerk/backend';

export type RouteAccess = 'public' | 'qstash' | 'user';

// Read-only, no LLM or embedding calls — what the public overview page loads.
const PUBLIC_GET: RegExp[] = [
  /^\/companies$/,
  /^\/insights\/[^/]+$/,
  /^\/sentiment$/,
  // The Scorecard's numbers and calendar are exchange data, but keep them behind
  // sign-in like the other research pages.
];

// Guarded by qstashVerify inside their routers instead of a user session.
const QSTASH_POST: RegExp[] = [
  /^\/ingest\/worker$/,
  /^\/keepalive\/(ping|daily-report|newsletter)$/,
  /^\/daily-filings\/run$/,
  /^\/companies\/refresh-all$/,
  /^\/market\/briefs\/run$/,
  // Authenticated by Telegram's secret-token header in the route itself.
  /^\/telegram\/webhook$/,
];

/** `path` is relative to /api, e.g. "/companies". */
export function routeAccess(method: string, path: string): RouteAccess {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const m = method.toUpperCase();
  if ((m === 'GET' || m === 'HEAD') && PUBLIC_GET.some(r => r.test(p))) return 'public';
  if (m === 'POST' && QSTASH_POST.some(r => r.test(p))) return 'qstash';
  return 'user';
}

export function bearerToken(header: string | undefined): string | null {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** The verified Clerk user id, set by requireAuth. Undefined on public routes and in dev bypass. */
export function currentUserId(res: Response): string | undefined {
  return res.locals.userId as string | undefined;
}

/**
 * Every /api route needs a valid Clerk session token unless it is listed above.
 * Before this, the browser hid pages behind AuthGate but the API itself was
 * open, so anyone with the Render URL could run ingestion and LLM endpoints.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === 'OPTIONS' || routeAccess(req.method, req.path) !== 'user') {
    next();
    return;
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    if (process.env.NODE_ENV === 'production') {
      res.status(500).json({ error: 'CLERK_SECRET_KEY is not configured on the backend' });
      return;
    }
    next(); // local development without Clerk, matching AuthGate's dev bypass
    return;
  }

  const token = bearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'Sign in required' });
    return;
  }

  try {
    const frontend = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
    const payload = await verifyToken(token, {
      secretKey,
      ...(frontend ? { authorizedParties: [frontend] } : {}),
    });
    res.locals.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}
