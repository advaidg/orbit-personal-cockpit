import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { drain, runCalls } from './agentHelpers.js';
import { approveProposal, undoExecution } from '../server/agent/proposals.js';
import { getCommitment } from '../server/agent/commitments.js';
import { applyAction, cleanNote, createPact, getPact, pactForToken, pacts, revokeLink, rotateLink, roleOf } from '../server/pacts/service.js';
import { notifications } from '../server/notify.js';
import { setServices } from '../server/agent/services.js';
import { saveAgentSettings } from '../server/agent/settings.js';

beforeEach(resetStorage);
const savedEnv = { ...process.env };
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); });

const input = { direction: 'they_owe' as const, otherPerson: 'Maya Chen', action: 'send the revised deck', dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString() };

describe(`pact links (${storageMode})`, () => {
  it('issues a link whose secret is never stored, and resolves it back to the pact', async () => {
    const owner = await freshOwner();
    const { pact, token, url } = await createPact(owner.id, input);
    expect(url).toContain(`/p/${token}`);
    const secret = token!.split('.')[1];
    expect(JSON.stringify(await pacts.get(owner.id, pact.id))).not.toContain(secret);
    expect((await pactForToken(token!))?.id).toBe(pact.id);
  });

  it('rejects tampered, malformed, expired, revoked and rotated links identically', async () => {
    const owner = await freshOwner();
    const { pact, token } = await createPact(owner.id, input);
    const [id, secret] = token!.split('.');
    expect(await pactForToken(`${id}.${secret.slice(0, -2)}xx`)).toBeNull();
    expect(await pactForToken('garbage')).toBeNull();
    expect(await pactForToken(`${'0'.repeat(36)}.${secret}`)).toBeNull();
    expect(await pactForToken(token!, new Date(Date.now() + 90 * 86_400_000))).toBeNull();
    const rotated = await rotateLink(owner.id, pact.id);
    expect(await pactForToken(token!)).toBeNull();
    expect((await pactForToken(rotated.token))?.id).toBe(pact.id);
    await revokeLink(owner.id, pact.id);
    expect(await pactForToken(rotated.token)).toBeNull();
  });

  it('never lets one owner’s link reach another owner’s pact', async () => {
    const a = await freshOwner('a');
    const b = await freshOwner('b');
    const first = await createPact(a.id, input);
    const second = await createPact(b.id, { ...input, action: 'a different thing' });
    const [, secretA] = first.token!.split('.');
    expect(await pactForToken(`${second.pact.id}.${secretA}`)).toBeNull();
    await expect(applyAction(b.id, first.pact.id, 'owner', 'done')).rejects.toThrow(/no longer exists/);
  });

  it('makes one pact per tracked item and links it to a commitment', async () => {
    const owner = await freshOwner();
    const first = await createPact(owner.id, input);
    const commitment = await getCommitment(owner.id, first.pact.commitmentId!);
    expect(commitment).toMatchObject({ direction: 'they_owe', otherPerson: 'Maya Chen', status: 'open' });
    const again = await createPact(owner.id, { ...input, commitmentId: first.pact.commitmentId });
    expect(again.created).toBe(false);
    expect(again.pact.id).toBe(first.pact.id);
    expect(again.token).toBeUndefined();
  });

  it('rejects invalid input before storing anything', async () => {
    const owner = await freshOwner();
    await expect(createPact(owner.id, { ...input, dueAt: 'not a date' })).rejects.toThrow(/date/);
    await expect(createPact(owner.id, { ...input, dueAt: new Date(Date.now() + 5 * 365 * 86_400_000).toISOString() })).rejects.toThrow(/too far/);
    await expect(createPact(owner.id, { ...input, action: '   ' })).rejects.toThrow(/person and a description/);
    expect(await pacts.count(owner.id)).toBe(0);
  });

  it('enforces the open-pact cap', async () => {
    process.env.PACT_MAX_OPEN = '2';
    const owner = await freshOwner();
    await createPact(owner.id, input);
    await createPact(owner.id, { ...input, action: 'two' });
    await expect(createPact(owner.id, { ...input, action: 'three' })).rejects.toThrow(/too many open pacts/i);
  });
});

describe(`pact actions (${storageMode})`, () => {
  it('derives roles from direction', () => {
    expect(roleOf('they_owe', 'owner')).toBe('requester');
    expect(roleOf('they_owe', 'counterparty')).toBe('doer');
    expect(roleOf('i_owe', 'owner')).toBe('doer');
    expect(roleOf('i_owe', 'peer')).toBe('requester');
  });

  it('closes the commitment when the other person says it is done, and tells the owner', async () => {
    const owner = await freshOwner();
    const { pact } = await createPact(owner.id, input);
    const result = await applyAction(owner.id, pact.id, 'counterparty', 'done', { note: 'Sent it just now' });
    expect(result.changed).toBe(true);
    expect(result.pact.status).toBe('done');
    expect((await getCommitment(owner.id, pact.commitmentId!))?.status).toBe('resolved');
    const [note] = await notifications.list(owner.id);
    expect(note.title).toMatch(/Maya Chen marked it done/);
    expect(note.body).toContain('Sent it just now');
  });

  it('lets the doer move the date and updates the follow-up, but only records a requester’s request', async () => {
    const owner = await freshOwner();
    const date = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const theyOwe = await createPact(owner.id, input);
    const moved = await applyAction(owner.id, theyOwe.pact.id, 'counterparty', 'reschedule', { date });
    expect(moved.pact.dueAt).toBe(date);
    expect((await getCommitment(owner.id, theyOwe.pact.commitmentId!))?.followUpAt).toBe(date);

    const iOwe = await createPact(owner.id, { ...input, direction: 'i_owe', action: 'review their draft' });
    const asked = await applyAction(owner.id, iOwe.pact.id, 'counterparty', 'reschedule', { date });
    expect(asked.pact.dueAt).toBe(iOwe.pact.dueAt);
    expect(asked.pact.requestedDueAt).toBe(date);
  });

  it('only offers each side the actions that make sense for it', async () => {
    const owner = await freshOwner();
    const { pact } = await createPact(owner.id, input); // counterparty is the doer
    await expect(applyAction(owner.id, pact.id, 'counterparty', 'cancel')).rejects.toThrow(/not available/);
    const mine = await createPact(owner.id, { ...input, direction: 'i_owe', action: 'pay the invoice' }); // counterparty is the requester
    await expect(applyAction(owner.id, mine.pact.id, 'counterparty', 'decline')).rejects.toThrow(/not available/);
    await expect(applyAction(owner.id, mine.pact.id, 'counterparty', 'reschedule')).rejects.toThrow(/new date/i);
  });

  it('is idempotent for confirm and refuses anything after the pact closes', async () => {
    const owner = await freshOwner();
    const { pact } = await createPact(owner.id, input);
    await applyAction(owner.id, pact.id, 'counterparty', 'confirm');
    const again = await applyAction(owner.id, pact.id, 'counterparty', 'confirm');
    expect(again.changed).toBe(false);
    expect(again.pact.events.filter((event) => event.action === 'confirm')).toHaveLength(1);
    await applyAction(owner.id, pact.id, 'counterparty', 'decline');
    await expect(applyAction(owner.id, pact.id, 'counterparty', 'done')).rejects.toThrow(/already declined/);
    expect((await getCommitment(owner.id, pact.commitmentId!))?.status).toBe('dismissed');
  });

  it('lets exactly one of several simultaneous clicks win', async () => {
    const owner = await freshOwner();
    const { pact } = await createPact(owner.id, input);
    const outcomes = await Promise.allSettled([1, 2, 3, 4].map(() => applyAction(owner.id, pact.id, 'counterparty', 'done')));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value.changed)).toHaveLength(1);
    expect((await getPact(owner.id, pact.id))?.events.filter((event) => event.action === 'done')).toHaveLength(1);
  });

  it('does not notify the owner about their own actions', async () => {
    const owner = await freshOwner();
    const { pact } = await createPact(owner.id, input);
    await applyAction(owner.id, pact.id, 'owner', 'done');
    expect(await notifications.count(owner.id)).toBe(0);
  });

  it('pings the owner on Telegram when the other person replies, if linked', async () => {
    const owner = await freshOwner();
    await saveAgentSettings(owner.id, { channels: { telegram: { enabled: true, chatId: '555' } } });
    const delivered: string[][] = [];
    const restore = setServices({ notifier: { deliver: async (_u, message, channels) => { delivered.push([message.title, ...channels]); return []; } } });
    try {
      const { pact } = await createPact(owner.id, input);
      await applyAction(owner.id, pact.id, 'counterparty', 'confirm');
    } finally { restore(); }
    expect(delivered).toEqual([['Maya Chen confirmed', 'telegram']]);
  });

  it('keeps stored notes plain and bounded', () => {
    expect(cleanNote('hello\u0000\u2028 world ' + 'x'.repeat(500))!.length).toBeLessThanOrEqual(280);
    expect(cleanNote('a\u0000b')).toBe('a b');
    expect(cleanNote('   ')).toBeUndefined();
    expect(cleanNote(42)).toBeUndefined();
  });
});

describe(`create_pact tool (${storageMode})`, () => {
  it('asks first, creates the pact on approval, never returns the link secret, and can be undone', async () => {
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [{ tool: 'create_pact', input: { direction: 'they_owe', otherPerson: 'Sam', action: 'send the contract' }, reason: 'You asked' }]);
    expect(proposals[0].status).toBe('pending');
    expect(proposals[0].preview.dataLeaving).toEqual([]);
    expect(await pacts.count(owner.id)).toBe(0);
    await approveProposal(owner.id, proposals[0].id);
    await drain();
    expect(await pacts.count(owner.id)).toBe(1);
    const execution = (await import('../server/agent/stores.js')).executionStore;
    const [run] = await execution.list(owner.id);
    expect(JSON.stringify(run)).not.toMatch(/\/p\/[0-9a-f-]{36}\./);
    await undoExecution(owner.id, proposals[0].id);
    expect(await pacts.count(owner.id)).toBe(0);
  });
});
