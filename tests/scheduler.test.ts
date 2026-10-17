import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { createTask, makeSignal } from './agentHelpers.js';
import { createCommitment, resolveCommitment } from '../server/agent/commitments.js';
import { createReminder, listReminders } from '../server/agent/reminders.js';
import { saveAgentSettings } from '../server/agent/settings.js';
import { setServices } from '../server/agent/services.js';
import { createNotifier, notifications, notifier } from '../server/notify.js';
import { fireDueReminders, tick, wakeSnoozedSignals } from '../server/scheduler.js';
import { getSignal, patchSignal, patchTask } from '../server/store.js';

beforeEach(resetStorage);
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });
const past = () => new Date(Date.now() - 60_000).toISOString();

describe(`reminders (${storageMode})`, () => {
  it('fires a due reminder exactly once, even if ticks overlap', async () => {
    restore = setServices({ notifier });
    const owner = await freshOwner();
    await createReminder(owner.id, { title: 'Call the dentist', remindAt: past() });
    const [a, b] = await Promise.all([fireDueReminders(), fireDueReminders()]);
    expect(a.fired + b.fired).toBe(1);
    expect((await notifications.list(owner.id)).map((n) => n.title)).toEqual(['Call the dentist']);
    expect((await fireDueReminders()).fired).toBe(0);
  });

  it('stays quiet when the commitment or task was already completed', async () => {
    const owner = await freshOwner();
    const { commitment } = await createCommitment(owner.id, { direction: 'they_owe', otherPerson: 'Maya', action: 'Send contract' });
    await createReminder(owner.id, { title: 'Follow up with Maya', remindAt: past(), commitmentId: commitment.id });
    await resolveCommitment(owner.id, commitment.id);
    const task = await createTask(owner.id, { title: 'File taxes' });
    await createReminder(owner.id, { title: 'File taxes', remindAt: past(), taskId: task.id });
    await patchTask(owner.id, task.id, { status: 'done' });
    const result = await fireDueReminders();
    expect(result).toEqual({ fired: 0, dismissed: 2 });
    expect(await notifications.list(owner.id)).toHaveLength(0);
    expect((await listReminders(owner.id)).every((r) => r.status === 'dismissed')).toBe(true);
  });

  it('holds reminders while the agent is paused and delivers them on resume', async () => {
    const owner = await freshOwner();
    await createReminder(owner.id, { title: 'Paused reminder', remindAt: past() });
    await saveAgentSettings(owner.id, { paused: true });
    expect((await fireDueReminders()).fired).toBe(0);
    await saveAgentSettings(owner.id, { paused: false });
    expect((await fireDueReminders()).fired).toBe(1);
  });
});

describe(`snooze (${storageMode})`, () => {
  it('brings a snoozed message back once, after its time', async () => {
    const owner = await freshOwner();
    const signal = await makeSignal(owner.id, { title: 'Follow up on lease' });
    await patchSignal(owner.id, signal.id, { metadata: { state: { status: 'snoozed', snoozedUntil: past() } } });
    const future = await makeSignal(owner.id, { title: 'Later' });
    await patchSignal(owner.id, future.id, { metadata: { state: { status: 'snoozed', snoozedUntil: new Date(Date.now() + 3600_000).toISOString() } } });
    expect(await wakeSnoozedSignals()).toBe(1);
    expect(await wakeSnoozedSignals()).toBe(0);
    expect((await getSignal(owner.id, signal.id))!.metadata!.state).toMatchObject({ status: 'open' });
    expect((await getSignal(owner.id, future.id))!.metadata!.state).toMatchObject({ status: 'snoozed' });
    expect((await notifications.list(owner.id))[0].title).toMatch(/snoozed message is back/);
  });
});

describe('notification delivery', () => {
  it('reports each channel separately and never leaks tokens', async () => {
    const owner = await freshOwner();
    await saveAgentSettings(owner.id, { channels: { telegram: { enabled: true, chatId: '12345' } } });
    const sent: string[] = [];
    const send = createNotifier({
      sendEmail: async (to, subject) => { sent.push(`email:${to}:${subject}`); },
      sendTelegram: async () => { throw new Error('Telegram rejected the message (401) token 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); }
    });
    const results = await send.deliver(owner.id, { title: 'Digest', body: 'Body', kind: 'digest' }, ['in_app', 'email', 'telegram']);
    expect(results.map((r) => [r.channel, r.ok])).toEqual([['in_app', true], ['email', true], ['telegram', false]]);
    expect(results[2].detail).not.toMatch(/AAAAAAAA/);
    expect(sent[0]).toMatch(/^email:.*owner.*:Orbit: Digest$/);
    expect(await notifications.list(owner.id)).toHaveLength(1);
  });

  it('fails clearly when a channel is not configured', async () => {
    const owner = await freshOwner();
    const results = await createNotifier({ sendEmail: undefined }).deliver(owner.id, { title: 'x', body: 'y', kind: 'info' }, ['telegram']);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].detail).toMatch(/No Telegram chat is linked/);
  });
});

describe(`scheduler tick (${storageMode})`, () => {
  it('runs every duty and reports what it did', async () => {
    restore = setServices({ notifier });
    const owner = await freshOwner();
    await createReminder(owner.id, { title: 'Tick reminder', remindAt: past() });
    const summary = await tick();
    expect(summary).toMatchObject({ remindersFired: 1, snoozesWoken: 0, automationsRun: 0 });
  });
});
