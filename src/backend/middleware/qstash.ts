import { Receiver } from '@upstash/qstash';
import { Request, Response, NextFunction } from 'express';

/**
 * Guards routes that only QStash should call (schedules and the ingest worker).
 *
 * - Signing keys missing in production → 503. The old code let every request
 *   through when the keys were unset, which left these routes open to anyone.
 * - Signing keys missing outside production → allowed, for local development.
 * - The old localhost bypass is gone: in-process callers (node-cron, discovery)
 *   now call functions directly instead of POSTing to their own server.
 */
export function qstashVerify(req: Request, res: Response, next: NextFunction): void {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey    = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentKey || !nextKey) {
    if (process.env.NODE_ENV === 'production') {
      res.status(503).json({ error: 'QStash signing keys are not configured' });
      return;
    }
    next();
    return;
  }

  const sig = req.headers['upstash-signature'] as string | undefined;
  if (!sig) { res.status(401).json({ error: 'Missing QStash signature' }); return; }

  const receiver = new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });
  const rawBody  = (req as Request & { rawBody?: string }).rawBody ?? '';
  receiver.verify({ signature: sig, body: rawBody })
    .then(() => next())
    .catch(() => { res.status(401).json({ error: 'Invalid QStash signature' }); });
}
