import { Router, Request, Response } from 'express';
import { validSecret, handleUpdate } from '../services/bot.service';

const router = Router();

// POST /api/telegram/webhook — Telegram calls this for every message to the bot.
// Authenticated by the secret token header, not a Clerk session.
router.post('/webhook', (req: Request, res: Response) => {
  if (!validSecret(req.header('x-telegram-bot-api-secret-token'))) {
    return res.status(401).json({ error: 'bad secret' });
  }
  // Answer at once: Telegram retries if the webhook takes long, and /ask can take ~20s.
  res.json({ ok: true });
  handleUpdate(req.body).catch(err => console.error('[bot] update failed:', err));
});

export { router as telegramRouter };
