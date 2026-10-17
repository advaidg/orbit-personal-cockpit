import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { drain, runCalls } from './agentHelpers.js';
import { handleUpdate, resetBotState } from '../server/telegram/bot.js';
import { consumeLinkCode, createLinkCode, isLinked, ownerForChat, resetLinkFailures } from '../server/telegram/link.js';
import { announcePendingProposals } from '../server/telegram/poller.js';
import { setTelegramApi, type Button, type TelegramApi, type TelegramUpdate } from '../server/telegram/api.js';
import { getAgentSettings, saveAgentSettings } from '../server/agent/settings.js';
import { proposalStore } from '../server/agent/stores.js';
import { getTasks } from '../server/store.js';
import { pacts } from '../server/pacts/service.js';

class FakeTelegram implements TelegramApi {
  sent: Array<{ chatId: string; text: string; buttons?: Button[][] }> = [];
  answers: string[] = [];
  async send(chatId: string, text: string, buttons?: Button[][]) { this.sent.push({ chatId, text, buttons }); }
  async answerCallback(_id: string, text?: string) { this.answers.push(text ?? ''); }
  async getUpdates() { return []; }
  async botUsername() { return 'orbit_test_bot'; }
  async verifyToken() { return { username: 'orbit_test_bot' }; }
  last() { return this.sent.at(-1)!; }
}

let api: FakeTelegram;
let restore: () => void;
const savedEnv = { ...process.env };
beforeEach(async () => {
  await resetStorage();
  resetBotState();
  resetLinkFailures();
  api = new FakeTelegram();
  restore = setTelegramApi(api);
});
afterEach(() => {
  restore();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

let updateId = 1;
const CHAT = 4242;
const say = (text: string, overrides: { chat?: number; type?: string; from?: number; date?: number } = {}): TelegramUpdate => ({
  update_id: updateId++,
  message: { message_id: updateId, date: overrides.date ?? Math.floor(Date.now() / 1000), text, chat: { id: overrides.chat ?? CHAT, type: overrides.type ?? 'private' }, from: { id: overrides.from ?? overrides.chat ?? CHAT } }
});
const press = (data: string, chat = CHAT): TelegramUpdate => ({ update_id: updateId++, callback_query: { id: `cb${updateId}`, data, from: { id: chat }, message: { chat: { id: chat, type: 'private' } } } });

async function linkedOwner() {
  const owner = await freshOwner('Alex');
  const { code } = await createLinkCode(owner.id);
  await handleUpdate(say(`/link ${code}`));
  return owner;
}

describe(`telegram linking (${storageMode})`, () => {
  it('links a private chat with a one-time code, and the code works once', async () => {
    const owner = await freshOwner();
    const { code } = await createLinkCode(owner.id);
    await handleUpdate(say(`/link ${code.toLowerCase()}`));
    expect(api.last().text).toMatch(/^Linked/);
    expect(await ownerForChat(String(CHAT))).toBe(owner.id);
    expect((await getAgentSettings(owner.id)).channels.telegram).toEqual({ enabled: true, chatId: String(CHAT) });
    expect(await consumeLinkCode(code, '999')).toBeNull();
    expect(await ownerForChat('999')).toBeNull();
  });

  it('refuses expired codes and locks a chat out after repeated wrong guesses', async () => {
    const owner = await freshOwner();
    const { code } = await createLinkCode(owner.id, new Date(Date.now() - 11 * 60_000));
    expect(await consumeLinkCode(code, '1')).toBeNull();
    const valid = await createLinkCode(owner.id);
    for (let attempt = 0; attempt < 5; attempt += 1) await consumeLinkCode('WRONGCODE', '7');
    expect(await consumeLinkCode(valid.code, '7')).toBeNull();
    expect(await consumeLinkCode(valid.code, '8')).toBe(owner.id);
  });

  it('caps unused codes', async () => {
    const owner = await freshOwner();
    for (let index = 0; index < 5; index += 1) await createLinkCode(owner.id);
    await expect(createLinkCode(owner.id)).rejects.toThrow(/Too many unused/);
  });

  it('ignores strangers: no commands run, one refusal a minute, nothing is asked', async () => {
    const owner = await freshOwner();
    await handleUpdate(say('/approvals'));
    await handleUpdate(say('who am I waiting on?'));
    await handleUpdate(say('/pause'));
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0].text).toMatch(/private Orbit assistant/);
    expect((await getAgentSettings(owner.id)).paused).toBe(false);
    const { runStore } = await import('../server/agent/stores.js');
    expect(await runStore.count(owner.id)).toBe(0);
  });

  it('only accepts private chats where the sender is the chat', async () => {
    const owner = await freshOwner();
    const { code } = await createLinkCode(owner.id);
    await handleUpdate(say(`/link ${code}`, { type: 'group' }));
    await handleUpdate(say(`/link ${code}`, { from: 1 }));
    expect(api.sent).toHaveLength(0);
    expect(await isLinked(owner.id)).toBe(false);
  });

  it('ignores a button press from a chat that is not linked', async () => {
    await freshOwner();
    await handleUpdate(press('a:whatever'));
    expect(api.answers).toEqual(['Not linked.']);
  });
});

describe(`telegram assistant (${storageMode})`, () => {
  it('answers questions from stored data', async () => {
    const owner = await linkedOwner();
    const { createCommitment } = await import('../server/agent/commitments.js');
    await createCommitment(owner.id, { direction: 'they_owe', otherPerson: 'Maya Chen', action: 'send the revised deck' });
    await handleUpdate(say('who am I waiting on?'));
    expect(api.last().text).toContain('Maya Chen');
  });

  it('shows pending actions with approve and reject buttons, and approving runs exactly that', async () => {
    const owner = await linkedOwner();
    await runCalls(owner.id, [{ tool: 'create_task', input: { title: 'Call the plumber' }, reason: 'Test' }]);
    await handleUpdate(say('/approvals'));
    const card = api.last();
    expect(card.text).toContain('Call the plumber');
    expect(card.text).toMatch(/Stays inside Orbit/);
    const [approve, reject] = card.buttons![0];
    expect(approve.data).toMatch(/^a:/);
    expect(reject.data).toMatch(/^r:/);
    expect(await getTasks(owner.id)).toHaveLength(0);
    await handleUpdate(press(approve.data!));
    await drain();
    expect((await getTasks(owner.id)).map((task) => task.title)).toEqual(['Call the plumber']);
    await handleUpdate(press(approve.data!));
    expect(api.answers.at(-1)).toMatch(/already executed|already approved/);
  });

  it('rejects from Telegram without doing anything', async () => {
    const owner = await linkedOwner();
    const { proposals } = await runCalls(owner.id, [{ tool: 'create_task', input: { title: 'Nope' }, reason: 'Test' }]);
    await handleUpdate(press(`r:${proposals[0].id}`));
    await drain();
    expect((await proposalStore.get(owner.id, proposals[0].id))?.status).toBe('rejected');
    expect(await getTasks(owner.id)).toHaveLength(0);
  });

  it('cannot approve around the pause switch: the same policy gate applies', async () => {
    const owner = await linkedOwner();
    const { proposals } = await runCalls(owner.id, [{ tool: 'create_task', input: { title: 'Held' }, reason: 'Test' }]);
    await saveAgentSettings(owner.id, { paused: true });
    await handleUpdate(press(`a:${proposals[0].id}`));
    await drain();
    expect(api.answers.at(-1)).toMatch(/paused/i);
    expect(await getTasks(owner.id)).toHaveLength(0);
    expect((await proposalStore.get(owner.id, proposals[0].id))?.status).toBe('pending');
  });

  it('announces new proposals once, and does not repeat ones it already showed', async () => {
    const owner = await linkedOwner();
    await runCalls(owner.id, [{ tool: 'create_task', input: { title: 'Announce me' }, reason: 'Test' }]);
    expect(await announcePendingProposals()).toBe(1);
    expect(await announcePendingProposals()).toBe(0);
    expect(api.last().text).toContain('Announce me');
    await handleUpdate(say('/approvals'));
    expect(api.sent.length).toBeGreaterThan(1);
  });

  it('creates a pact from chat and hands back a message to forward, without sending it', async () => {
    const owner = await linkedOwner();
    const before = api.sent.length;
    const due = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await handleUpdate(say(`/pact they Maya Chen | send the contract | ${due}`));
    expect(api.sent.length - before).toBe(2);
    expect(api.sent.at(-2)!.text).toMatch(/haven’t sent it to anyone/);
    expect(api.last().text).toMatch(/\/p\/[\w-]+\.[\w-]+/);
    const [pact] = await pacts.list(owner.id);
    expect(pact).toMatchObject({ direction: 'they_owe', otherPerson: 'Maya Chen', action: 'send the contract' });
    expect(Math.abs(Date.parse(pact.dueAt!) - Date.parse(due))).toBeLessThan(2 * 86_400_000);
    await handleUpdate(say('/pact someone Maya'));
    expect(api.last().text).toMatch(/Use: \/pact/);
    await handleUpdate(say('/pact me Dana | file taxes | when the moon is blue'));
    expect(api.last().text).toMatch(/couldn’t read/);
  });

  it('marks a pact done from its button', async () => {
    const owner = await linkedOwner();
    await handleUpdate(say('/pact me Dana | file taxes'));
    await handleUpdate(say('/pacts'));
    const done = api.last().buttons![0][0].data!;
    await handleUpdate(press(done));
    expect((await pacts.list(owner.id))[0].status).toBe('done');
  });

  it('pauses, resumes and unlinks on command, after which the chat is a stranger again', async () => {
    const owner = await linkedOwner();
    await handleUpdate(say('/pause'));
    expect((await getAgentSettings(owner.id)).paused).toBe(true);
    await handleUpdate(say('/resume'));
    expect((await getAgentSettings(owner.id)).paused).toBe(false);
    await handleUpdate(say('/unlink'));
    expect(await isLinked(owner.id)).toBe(false);
    expect((await getAgentSettings(owner.id)).channels.telegram.enabled).toBe(false);
    const before = api.sent.length;
    resetBotState();
    await handleUpdate(say('/approvals'));
    expect(api.sent.length - before).toBe(1);
    expect(api.last().text).toMatch(/private Orbit assistant/);
  });

  it('ignores old messages that were queued while Orbit was offline', async () => {
    await linkedOwner();
    const before = api.sent.length;
    await handleUpdate(say('/pause', { date: Math.floor(Date.now() / 1000) - 2 * 3600 }));
    expect(api.sent.length).toBe(before);
  });

  it('answers politely when the agent is switched off', async () => {
    await linkedOwner();
    process.env.AGENT_ENABLED = 'false';
    await handleUpdate(say('prepare replies to everything urgent'));
    expect(api.last().text).toMatch(/turned off/);
  });
});
