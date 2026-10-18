import { createNotification } from '../notify.js';
import { logSafe } from '../diagnostics.js';
import { telegramApi, type Button } from '../telegram/api.js';
import { boundChats } from '../telegram/link.js';
import { guardHooks } from './engine.js';
import type { GuardRequest } from './types.js';

export function requestCard(request: GuardRequest): { text: string; buttons: Button[][] } {
  const lines = [
    `🛡 ${request.agentName} is waiting for you`,
    '',
    request.summary.slice(0, 500),
    request.project ? `Project: ${request.project}` : '',
    '',
    request.reasons.length ? `Why Orbit stopped it:\n${request.reasons.map((reason) => `• ${reason}`).join('\n')}` : 'Orbit stopped it because it is not clearly safe.',
    '',
    `It waits until ${new Date(request.expiresAt).toISOString().slice(11, 16)} UTC, then goes back to the agent’s own prompt.`
  ];
  const row: Button[] = [{ text: 'Approve', data: `ga:${request.id}` }, { text: 'Deny', data: `gd:${request.id}` }];
  const more: Button[] = request.cwd ? [{ text: 'Always allow this here', data: `gA:${request.id}` }] : [];
  return { text: lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n'), buttons: more.length ? [row, more] : [row] };
}

/** Tells the owner a call is waiting: a Telegram card with buttons, plus an in-app notification. */
export async function announceRequest(request: GuardRequest): Promise<void> {
  await createNotification(request.userId, { title: `${request.agentName} needs your OK`, body: request.summary.slice(0, 300), kind: 'alert', link: '/#/guard' }).catch((error) => logSafe('guard notification', error));
  const chats = (await boundChats()).filter((chat) => chat.userId === request.userId);
  const card = requestCard(request);
  for (const chat of chats) await telegramApi().send(chat.chatId, card.text, card.buttons).catch((error) => logSafe('guard telegram', error));
}

export function registerGuardNotifications(): void {
  guardHooks.onRequest = announceRequest;
}
