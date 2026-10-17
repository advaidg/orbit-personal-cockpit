import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { createTask, drain, makeSignal } from './agentHelpers.js';
import { createFakeGmail } from './fakeGmail.js';
import { RECIPES, automationInput, createAutomation, createFromRecipe, matchesFilter, runAutomationNow, runDueAutomations, runSignalAutomations, getAutomation } from '../server/agent/automations.js';
import { createCommitment, listCommitments } from '../server/agent/commitments.js';
import { createMemory } from '../server/agent/memory.js';
import { setServices } from '../server/agent/services.js';
import { saveAgentSettings } from '../server/agent/settings.js';
import { proposalStore, runStore } from '../server/agent/stores.js';
import { notifications, notifier } from '../server/notify.js';
import { getTasks } from '../server/store.js';
import { listReminders } from '../server/agent/reminders.js';
import { setServices as setSvc } from '../server/agent/services.js';

beforeEach(resetStorage);
const saved = { ...process.env };
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
const useNotifier = () => { restore = setSvc({ notifier }); };

describe('starter recipes', () => {
  it('ships the eight recipes from the roadmap and all of them are valid', () => {
    expect(RECIPES.map((recipe) => recipe.id).sort()).toEqual(['bills-due', 'end-of-day', 'important-person', 'meeting-request', 'morning-brief', 'no-response', 'travel-changes', 'weekly-waiting-on']);
    for (const recipe of RECIPES) expect(() => automationInput.parse(recipe.input)).not.toThrow();
    expect(RECIPES.every((recipe) => recipe.input.enabled === false)).toBe(true);
  });

  it('matches filters on category, keyword (regex or text), sender, priority and important people', async () => {
    const owner = await freshOwner();
    const signal = await makeSignal(owner.id, { category: 'travel', title: 'Your flight changed', sender: 'United <ua@united.com>' });
    expect(matchesFilter({ category: 'travel' }, signal, false)).toBe(true);
    expect(matchesFilter({ category: 'money' }, signal, false)).toBe(false);
    expect(matchesFilter({ keyword: 'flight|hotel' }, signal, false)).toBe(true);
    expect(matchesFilter({ keyword: '([unclosed' }, signal, false)).toBe(false);
    expect(matchesFilter({ sender: 'united' }, signal, false)).toBe(true);
    expect(matchesFilter({ priority: 'later' }, signal, false)).toBe(false);
    expect(matchesFilter({ importantPeopleOnly: true }, signal, false)).toBe(false);
    expect(matchesFilter({ importantPeopleOnly: true }, signal, true)).toBe(true);
    expect(matchesFilter({}, { ...signal, metadata: { direction: 'outbound' } }, false)).toBe(false);
  });
});

describe(`event automations (${storageMode})`, () => {
  it('turns a travel email into a task and an alert, respecting its approval mode', async () => {
    useNotifier();
    const owner = await freshOwner();
    await createFromRecipe(owner.id, 'travel-changes', true);
    const signal = await makeSignal(owner.id, { category: 'travel', title: 'Flight moved earlier', summary: 'Departure is 55 minutes earlier.' });
    const proposals = await runSignalAutomations(owner.id, [signal]);
    expect(proposals).toBe(2);
    await drain();
    expect((await getTasks(owner.id)).map((task) => task.title)).toEqual(['Review travel change: Flight moved earlier']);
    expect((await notifications.list(owner.id))[0]).toMatchObject({ title: 'Travel update: Flight moved earlier', kind: 'alert' });
  });

  it('asks first when the automation is set to always ask, and previews on a dry run', async () => {
    const owner = await freshOwner();
    const automation = await createAutomation(owner.id, { name: 'Ask first', trigger: { type: 'new_email' }, filter: { category: 'money' }, actions: [{ kind: 'create_task', title: 'Pay: {title}' }], approval: 'always_ask' });
    const signal = await makeSignal(owner.id, { category: 'money', title: 'Invoice 1048' });
    await runSignalAutomations(owner.id, [signal]);
    expect((await proposalStore.list(owner.id))[0].status).toBe('pending');
    expect(await getTasks(owner.id)).toHaveLength(0);
    await resetStorage();
    const owner2 = await freshOwner();
    const dry = await createAutomation(owner2.id, { name: 'Dry', trigger: { type: 'new_email' }, filter: { category: 'money' }, actions: [{ kind: 'create_task', title: 'Pay: {title}' }], approval: 'auto', dryRun: true });
    await runSignalAutomations(owner2.id, [await makeSignal(owner2.id, { category: 'money', title: 'Invoice 1048' })]);
    expect((await proposalStore.list(owner2.id))[0].status).toBe('previewed');
    expect(await drain()).toBe(0);
    void automation; void dry;
  });

  it('can be tested on demand with a dry run against the latest matching message', async () => {
    const owner = await freshOwner();
    const automation = await createAutomation(owner.id, { name: 'Test me', trigger: { type: 'new_email' }, filter: { category: 'money' }, actions: [{ kind: 'create_task', title: 'Pay: {title}' }], approval: 'auto' });
    await expect(runAutomationNow(owner.id, automation.id)).rejects.toThrow(/nothing to test/i);
    await makeSignal(owner.id, { category: 'money', title: 'Invoice 7' });
    const result = await runAutomationNow(owner.id, automation.id, { dryRun: true });
    expect(result.proposals).toBe(1);
    expect((await proposalStore.list(owner.id))[0].status).toBe('previewed');
    expect(await getTasks(owner.id)).toHaveLength(0);
  });

  it('alerts for important people only', async () => {
    useNotifier();
    const owner = await freshOwner();
    await createFromRecipe(owner.id, 'important-person', true);
    await createMemory(owner.id, { type: 'important_person', statement: 'Messages from maya@example.com are high priority.', params: { email: 'maya@example.com' } });
    const maya = await makeSignal(owner.id, { title: 'Contract', sender: 'Maya <maya@example.com>' });
    const other = await makeSignal(owner.id, { title: 'Promo', sender: 'Bob <bob@example.com>', metadata: { fromAddress: 'bob@example.com', direction: 'inbound' } });
    expect(await runSignalAutomations(owner.id, [maya, other])).toBe(1);
    await drain();
    expect((await notifications.list(owner.id)).map((n) => n.title)).toEqual(['From Maya: Contract']);
  });

  it('honours the per-automation daily limit, the pause switch, the kill switch and the installation switch', async () => {
    const owner = await freshOwner();
    const automation = await createAutomation(owner.id, { name: 'Limited', trigger: { type: 'new_email' }, filter: {}, actions: [{ kind: 'create_task', title: '{title}' }], approval: 'always_ask', maxRunsPerDay: 2 });
    const signals = await Promise.all([1, 2, 3].map((n) => makeSignal(owner.id, { title: `Message ${n}` })));
    await runSignalAutomations(owner.id, signals);
    expect(await proposalStore.count(owner.id)).toBe(2);
    expect((await getAutomation(owner.id, automation.id))!.lastRunStatus).toBe('skipped');

    await saveAgentSettings(owner.id, { automationsKilled: true });
    expect(await runSignalAutomations(owner.id, [await makeSignal(owner.id, { title: 'Killed' })])).toBe(0);
    await saveAgentSettings(owner.id, { automationsKilled: false, paused: true });
    expect(await runSignalAutomations(owner.id, [await makeSignal(owner.id, { title: 'Paused' })])).toBe(0);
    await saveAgentSettings(owner.id, { paused: false });
    process.env.AUTOMATIONS_ENABLED = 'false';
    expect(await runSignalAutomations(owner.id, [await makeSignal(owner.id, { title: 'Disabled' })])).toBe(0);
    expect(await proposalStore.count(owner.id)).toBe(2);
  });

  it('notifies the owner when an automation fails', async () => {
    process.env.AGENT_MAX_RUNS_PER_DAY = '1';
    const owner = await freshOwner();
    await createAutomation(owner.id, { name: 'Fragile', trigger: { type: 'new_email' }, filter: {}, actions: [{ kind: 'create_task', title: '{title}' }], approval: 'always_ask', notifyOnFailure: true });
    const [a, b] = [await makeSignal(owner.id, { title: 'A' }), await makeSignal(owner.id, { title: 'B' })];
    await runSignalAutomations(owner.id, [a, b]);
    const failure = (await notifications.list(owner.id)).find((item) => item.kind === 'failure');
    expect(failure?.title).toMatch(/Fragile/);
  });
});

describe(`scheduled automations (${storageMode})`, () => {
  it('runs a due schedule exactly once even when two instances tick together', async () => {
    useNotifier();
    const owner = await freshOwner();
    const automation = await createFromRecipe(owner.id, 'morning-brief', true);
    expect(automation.nextRunAt).toBeDefined();
    const due = new Date(new Date(automation.nextRunAt!).getTime() + 60_000);
    await createTask(owner.id, { title: 'Send contract', priority: 'now' });
    const results = await Promise.all([runDueAutomations(due), runDueAutomations(due)]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    await drain();
    const digest = (await notifications.list(owner.id)).filter((item) => item.kind === 'digest');
    expect(digest).toHaveLength(1);
    expect(digest[0].body).toMatch(/Send contract/);
    const next = (await getAutomation(owner.id, automation.id))!.nextRunAt!;
    expect(next > due.toISOString()).toBe(true);
    expect(await runDueAutomations(due)).toBe(0);
  });

  it('adds reminders for bills due soon without repeating itself', async () => {
    useNotifier();
    const owner = await freshOwner();
    const automation = await createFromRecipe(owner.id, 'bills-due', true);
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await createTask(owner.id, { title: 'Pay River & Co. invoice', dueAt: soon, priority: 'soon' });
    await createTask(owner.id, { title: 'Pay far-off invoice', dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), priority: 'soon' });
    const due = new Date(new Date(automation.nextRunAt!).getTime() + 1000);
    await runDueAutomations(due);
    await drain();
    expect((await listReminders(owner.id)).map((reminder) => reminder.title)).toEqual(['Due soon: Pay River & Co. invoice']);
    const second = await getAutomation(owner.id, automation.id);
    await import('../server/agent/automations.js').then(async ({ automationStore }) => automationStore.update(owner.id, automation.id, { nextRunAt: new Date(due.getTime() - 1000).toISOString() }));
    await runDueAutomations(new Date(due.getTime() + 1000));
    await drain();
    expect(await listReminders(owner.id)).toHaveLength(1);
    expect(second!.firedKeys).toHaveLength(1);
  });

  it('drafts a polite follow-up for commitments that have gone quiet, once per round', async () => {
    const owner = await freshOwner();
    const fake = createFakeGmail({ headers: { m1: { from: 'Maya <maya@example.com>', subject: 'Contract', threadId: 't1', messageIdHeader: '<m1@x>' } } });
    restore = setServices({ gmail: fake.gateway });
    await saveAgentSettings(owner.id, { gmailAccess: 'drafts' });
    const signal = await makeSignal(owner.id, { sourceId: 'm1' });
    const created = new Date(Date.now() - 6 * 86_400_000);
    const { commitment } = await createCommitment(owner.id, { direction: 'they_owe', otherPerson: 'Maya Chen', otherEmail: 'maya@example.com', action: 'Send the revised contract', evidenceSignalId: signal.id, threadId: 't1' }, created);
    const automation = await createFromRecipe(owner.id, 'no-response', true);
    const due = new Date(new Date(automation.nextRunAt!).getTime() + 1000);
    await runDueAutomations(due);
    const [proposal] = await proposalStore.list(owner.id);
    expect(proposal).toMatchObject({ toolName: 'draft_reply', status: 'pending' });
    expect(proposal.input.kind).toBe('follow_up');
    expect(String(proposal.input.body)).toMatch(/follow up on send the revised contract/i);
    const [updated] = await listCommitments(owner.id);
    expect(updated.followUpCount).toBe(1);
    expect(updated.followUpAt! > due.toISOString()).toBe(true);
    void commitment;
  });
});
