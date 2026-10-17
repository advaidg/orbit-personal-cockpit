import express from 'express';
import { pactLimits } from '../pacts/config.js';
import { telegramApi } from '../telegram/api.js';
import { createLinkCode, isLinked, unlink } from '../telegram/link.js';
import { telegramConfigured } from '../telegram/poller.js';
import { ActionableError } from '../diagnostics.js';
import { handle, ownerId } from './http.js';

export const channelsRouter = express.Router();

channelsRouter.get('/telegram', handle(async (_req, res) => {
  const configured = telegramConfigured();
  res.json({ configured, inbound: configured && pactLimits().telegramInbound, linked: await isLinked(ownerId(res)), bot: configured ? await telegramApi().botUsername() : undefined });
}));

channelsRouter.post('/telegram/link', handle(async (_req, res) => {
  if (!telegramConfigured()) throw new ActionableError('Telegram is not set up on this installation.', { action: 'Create a bot with @BotFather, set TELEGRAM_BOT_TOKEN, and redeploy.', code: 'telegram_missing' });
  if (!pactLimits().telegramInbound) throw new ActionableError('Chatting with Orbit on Telegram is turned off.', { action: 'Set TELEGRAM_INBOUND_ENABLED=true and redeploy.', code: 'telegram_inbound_off' });
  const { code, expiresAt } = await createLinkCode(ownerId(res));
  const bot = await telegramApi().botUsername();
  res.status(201).json({ code, expiresAt, bot, instructions: `Open ${bot ? `@${bot}` : 'your bot'} on Telegram and send: /link ${code}` });
}));

channelsRouter.delete('/telegram', handle(async (_req, res) => {
  await unlink(ownerId(res));
  res.status(204).end();
}));
