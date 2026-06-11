import { Receiver } from '@upstash/qstash';
import { Request, Response, NextFunction } from 'express';

export function qstashVerify(req: Request, res: Response, next: NextFunction): void {
  console.log(`[qstash] ${req.method} ${req.path} ip=${req.ip}`);
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey    = process.env.QSTASH_NEXT_SIGNING_KEY;

  // Skip if keys not configured (dev) or if caller is localhost (node-cron fallback)
  if (!currentKey || !nextKey) {
    console.log('[qstash] no keys → bypass');
    next();
    return;
  }
  const ip = req.ip ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    console.log('[qstash] localhost → bypass');
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
