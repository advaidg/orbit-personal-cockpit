import { agentLimits } from '../agent/config.js';
import { askOrbit } from '../agent/ask.js';
import { listCommitments } from '../agent/commitments.js';
import { parseExpectedDate } from '../agent/detect.js';
import { morningBrief } from '../agent/digests.js';
import { approveProposal, listPending, rejectProposal } from '../agent/proposals.js';
import { getAgentSettings, saveAgentSettings } from '../agent/settings.js';
import { proposalStore } from '../agent/stores.js';
import type { ActionProposal } from '../agent/types.js';
import { ActionableError, logSafe } from '../diagnostics.js';
import { applyAction, createPact, listPacts, shareMessage } from '../pacts/service.js';
import { getUser } from '../store.js';
import { telegramApi, type Button, type TelegramApi, type TelegramUpdate } from './api.js';
import { consumeLinkCode, ownerForChat, unlink } from './link.js';
import { resolveRequest } from '../guard/engine.js';

const HELP = [
  'Orbit, from your pocket.',
  '',
  'Just write to me: “who am I waiting on?” or “what do I owe?”.',
  '',
  '/approvals — actions waiting for your OK',
  '/waiting — what others owe you',
  '/owe — what you owe',
  '/pacts — open pacts',
  '/pact they|me Name | what | when — make a pact and get a link to forward',
  '/brief — your morning brief',
  '/pause and /resume — stop or restart the agent',
  '/unlink — disconnect this chat',
  '',
  'I never send anything for you. I only ask, then do exactly what you approve.'
].join('\n');

const STALE_MESSAGE_SECONDS = 60 * 60;
const MAX_CARDS = 5;
const PRIVATE_NOTICE = 'This is a private Orbit assistant. Link it from Orbit → Connections.';

const noticeAt = new Map<string, number>();

/** Replies to strangers at most once a minute, so the bot cannot be used to spam anyone. */
function mayNotify(chatId: string, now: number): boolean {
  const last = noticeAt.get(chatId) ?? 0;
  if (now - last < 60_000) return false;
  noticeAt.set(chatId, now);
  return true;
}

export function resetBotState(): void {
  noticeAt.clear();
}

const dayText = (iso?: string) => (iso ? iso.slice(0, 10) : 'no date');

export function proposalCard(proposal: ActionProposal): { text: string; buttons: Button[][] } {
  const { preview } = proposal;
  const lines = [preview.title, '', preview.description.slice(0, 500), '', proposal.reason ? `Why: ${proposal.reason.slice(0, 200)}` : '', preview.dataLeaving.length ? `Leaves Orbit: ${preview.dataLeaving.join(' ').slice(0, 300)}` : 'Stays inside Orbit.', preview.editable?.length ? 'You can edit this in Orbit before approving.' : ''].filter((line, index, all) => line !== '' || all[index - 1] !== '');
  const row: Button[] = [{ text: 'Approve', data: `a:${proposal.id}` }, { text: 'Reject', data: `r:${proposal.id}` }];
  const link = process.env.APP_URL?.startsWith('https://') ? [{ text: 'Open in Orbit', url: `${process.env.APP_URL.replace(/\/$/, '')}/#/approvals` }] : [];
  return { text: lines.join('\n'), buttons: [row, ...(link.length ? [link] : [])] };
}

export async function sendProposalCards(api: TelegramApi, userId: string, chatId: string, proposals: ActionProposal[], now = new Date()): Promise<number> {
  let sent = 0;
  for (const proposal of proposals.slice(0, MAX_CARDS)) {
    const card = proposalCard(proposal);
    await api.send(chatId, card.text, card.buttons);
    await proposalStore.update(userId, proposal.id, { telegramNotifiedAt: now.toISOString() });
    sent += 1;
  }
  return sent;
}

async function parsePact(userId: string, text: string, now: Date) {
  const match = /^\/pact(?:@\w+)?\s+(they|me)\s+(.+)$/is.exec(text.trim());
  if (!match) throw new ActionableError('Use: /pact they Maya | send the deck | friday', { action: 'Write “they” if they owe you, “me” if you owe them.', code: 'invalid_request' });
  const [person, action, when] = match[2].split('|').map((part) => part.trim());
  if (!person || !action) throw new ActionableError('Use: /pact they Maya | send the deck | friday', { action: 'Name, what, and optionally when, separated by |.', code: 'invalid_request' });
  const settings = await getAgentSettings(userId);
  const dueAt = when ? parseExpectedDate(when, now, settings.timezone) ?? undefined : undefined;
  if (when && !dueAt) throw new ActionableError(`I couldn’t read “${when.slice(0, 40)}” as a date.`, { action: 'Try “friday”, “in 3 days” or 2026-10-30.', code: 'invalid_date' });
  return { direction: (match[1].toLowerCase() === 'they' ? 'they_owe' : 'i_owe') as 'they_owe' | 'i_owe', otherPerson: person, action, dueAt };
}

async function listText(userId: string, direction: 'they_owe' | 'i_owe'): Promise<string> {
  const items = (await listCommitments(userId, { status: ['open', 'snoozed'], direction })).slice(0, 10);
  if (!items.length) return direction === 'they_owe' ? 'Nobody owes you anything right now.' : 'You are all caught up.';
  return `${direction === 'they_owe' ? 'Waiting on' : 'You owe'}:\n${items.map((item) => `• ${item.otherPerson}: ${item.action} (${dayText(item.expectedAt)})`).join('\n')}`;
}

async function handleCommand(api: TelegramApi, userId: string, chatId: string, text: string, now: Date): Promise<void> {
  const [raw] = text.trim().split(/\s+/);
  const command = raw.toLowerCase().replace(/@\w+$/, '');
  switch (command) {
    case '/start':
    case '/help': return api.send(chatId, HELP);
    case '/approvals': {
      const pending = await listPending(userId);
      if (!pending.length) return api.send(chatId, 'Nothing is waiting for your approval.');
      await sendProposalCards(api, userId, chatId, pending, now);
      if (pending.length > MAX_CARDS) await api.send(chatId, `${pending.length - MAX_CARDS} more are waiting in Orbit.`);
      return;
    }
    case '/waiting': return api.send(chatId, await listText(userId, 'they_owe'));
    case '/owe': return api.send(chatId, await listText(userId, 'i_owe'));
    case '/pacts': {
      const open = (await listPacts(userId, ['open'])).slice(0, 8);
      if (!open.length) return api.send(chatId, 'No open pacts. Try /pact they Maya | send the deck | friday');
      for (const pact of open) await api.send(chatId, `${pact.direction === 'they_owe' ? pact.otherPerson : `You → ${pact.otherPerson}`}: ${pact.action}\nDue ${dayText(pact.dueAt)}${pact.confirmed ? ' · confirmed' : ''}`, [[{ text: 'Mark done', data: `pd:${pact.id}` }]]);
      return;
    }
    case '/pact': {
      const input = await parsePact(userId, text, now);
      const { pact, url, created } = await createPact(userId, input, now);
      if (!created || !url) return api.send(chatId, 'That pact already exists. Open Orbit → Pacts to get a fresh link.');
      const owner = await getUser(userId);
      await api.send(chatId, 'Pact created. Forward this message — I haven’t sent it to anyone:');
      return api.send(chatId, shareMessage(pact, url, owner?.name ?? ''));
    }
    case '/brief': {
      const settings = await getAgentSettings(userId);
      const brief = await morningBrief(userId, now, settings.timezone);
      return api.send(chatId, `${brief.title}\n\n${brief.body}`);
    }
    case '/pause':
    case '/resume': {
      const paused = command === '/pause';
      await saveAgentSettings(userId, { paused });
      return api.send(chatId, paused ? 'Paused. I won’t run anything until you /resume.' : 'Resumed.');
    }
    case '/unlink':
      await unlink(userId);
      return api.send(chatId, 'Disconnected. Link again from Orbit → Connections any time.');
    default: return api.send(chatId, 'I don’t know that command. /help lists what I can do.');
  }
}

async function handleText(api: TelegramApi, userId: string, chatId: string, text: string, now: Date): Promise<void> {
  if (!agentLimits().enabled) return api.send(chatId, 'The agent is turned off on this installation (AGENT_ENABLED=false).');
  const result = await askOrbit(userId, text, now);
  await api.send(chatId, result.answer.slice(0, 3500) || 'Done.');
  if (result.proposals.length) await sendProposalCards(api, userId, chatId, result.proposals.filter((proposal) => proposal.status === 'pending'), now);
}

async function handleCallback(api: TelegramApi, userId: string, chatId: string, callbackId: string, data: string): Promise<void> {
  const [kind, id] = data.split(':');
  if (!id || id.length > 64) return api.answerCallback(callbackId, 'That button is out of date.');
  try {
    if (kind === 'a') {
      await approveProposal(userId, id);
      await api.answerCallback(callbackId, 'Approved');
      return api.send(chatId, 'Approved. I’ll do exactly that and nothing more.');
    }
    if (kind === 'r') {
      await rejectProposal(userId, id, 'Rejected from Telegram');
      await api.answerCallback(callbackId, 'Rejected');
      return api.send(chatId, 'Rejected. Nothing was done.');
    }
    if (kind === 'ga' || kind === 'gA' || kind === 'gd') {
      const decision = kind === 'gd' ? 'denied' : 'approved';
      const done = await resolveRequest(userId, id, decision, { remember: kind === 'gA' });
      if (!done) return api.answerCallback(callbackId, 'Already answered, or it timed out.');
      await api.answerCallback(callbackId, decision === 'approved' ? (done.remembered ? 'Approved — remembered here' : 'Approved') : 'Denied');
      return api.send(chatId, decision === 'approved' ? `✅ Approved. ${done.agentName} continues.${done.remembered ? ' I’ll allow this exact call in this project from now on.' : ''}` : `⛔ Denied. ${done.agentName} was told no.`);
    }
    if (kind === 'pd') {
      await applyAction(userId, id, 'owner', 'done');
      await api.answerCallback(callbackId, 'Marked done');
      return;
    }
    return api.answerCallback(callbackId, 'That button is out of date.');
  } catch (error) {
    if (error instanceof ActionableError) return api.answerCallback(callbackId, `${error.message} ${error.options.action ?? ''}`.trim());
    throw error;
  }
}

/**
 * Handles one Telegram update. Only a private chat that the owner linked with a one-time code is ever obeyed;
 * everything else gets, at most, a single polite refusal. Approvals use the same policy gate as the web app.
 */
export async function handleUpdate(update: TelegramUpdate, api: TelegramApi = telegramApi(), now = new Date()): Promise<void> {
  try {
    const callback = update.callback_query;
    if (callback) {
      const chat = callback.message?.chat;
      if (!chat || chat.type !== 'private' || String(callback.from.id) !== String(chat.id)) return;
      const userId = await ownerForChat(String(chat.id));
      if (!userId) return void (await api.answerCallback(callback.id, 'Not linked.'));
      return await handleCallback(api, userId, String(chat.id), callback.id, callback.data ?? '');
    }
    const message = update.message;
    if (!message?.text || message.chat.type !== 'private' || message.from?.is_bot || String(message.from?.id) !== String(message.chat.id)) return;
    if (now.getTime() / 1000 - message.date > STALE_MESSAGE_SECONDS) return;
    const chatId = String(message.chat.id);
    const text = message.text.trim().slice(0, 600);
    const userId = await ownerForChat(chatId);
    if (!userId) {
      const link = /^\/(?:start|link)(?:@\w+)?\s+([A-Za-z0-9]{6,16})\s*$/.exec(text);
      if (link) {
        const linked = await consumeLinkCode(link[1], chatId, now);
        return void (await api.send(chatId, linked ? `Linked. ${HELP}` : 'That code didn’t work. Codes last ten minutes and work once — make a new one in Orbit → Connections.'));
      }
      if (mayNotify(chatId, now.getTime())) await api.send(chatId, PRIVATE_NOTICE);
      return;
    }
    if (text.startsWith('/')) return await handleCommand(api, userId, chatId, text, now);
    return await handleText(api, userId, chatId, text, now);
  } catch (error) {
    if (error instanceof ActionableError) {
      const chatId = String(update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? '');
      if (chatId) await api.send(chatId, `${error.message} ${error.options.action ?? ''}`.trim()).catch(() => undefined);
      return;
    }
    logSafe('telegram update', error);
  }
}
