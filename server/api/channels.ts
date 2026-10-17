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
  if (!telegramConfigured()) throw new ActionableError('Telegram is not set up on this installation.', { action: 'Open Connections → Setup and connect your Telegram bot first.', code: 'telegram_missing' });
  if (!pactLimits().telegramInbound) throw new ActionableError('Chatting with Orbit on Telegram is turned off.', { action: 'The installation owner has turned chat off (TELEGRAM_INBOUND_ENABLED=false).', code: 'telegram_inbound_off' });
  const { code, expiresAt } = await createLinkCode(ownerId(res));
  const bot = await telegramApi().botUsername();
  // t.me deep links open the bot and send `/start CODE` with one tap, so nothing has to be typed.
  res.status(201).json({ code, expiresAt, bot, url: bot ? `https://t.me/${bot}?start=${code}` : undefined, instructions: `Open ${bot ? `@${bot}` : 'your bot'} on Telegram and send: /link ${code}` });
}));

channelsRouter.delete('/telegram', handle(async (_req, res) => {
  await unlink(ownerId(res));
  res.status(204).end();
}));
