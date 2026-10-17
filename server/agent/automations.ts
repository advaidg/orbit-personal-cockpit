import crypto from 'node:crypto';
import { z } from 'zod';
import { ActionableError, logSafe } from '../diagnostics.js';
import { createNotification, ownerChannels } from '../notify.js';
import { Collection, type Owned } from '../collection.js';
import { getSettings, getSignals, getTasks, getUser } from '../store.js';
import type { Signal } from '../types.js';
import { agentLimits } from './config.js';
import { composeDraft } from './compose.js';
import { bumpFollowUp, followUpCall } from './followups.js';
import { listCommitments } from './commitments.js';
import { endOfDay, morningBrief, weeklyWaitingOn, type Digest } from './digests.js';
import { listMemories, shareableMemories } from './memory.js';
import { isImportantPerson } from './memoryRules.js';
import type { AutomationApproval } from './policy.js';
import { proposeCalls, type PlannedCall } from './proposals.js';
import { startRun, failRun } from './runs.js';
import { getAgentSettings } from './settings.js';
import { runStore } from './stores.js';
import { nextDailyRun, nextWeeklyRun } from './time.js';
import { displayName, extractEmail } from './tools/util.js';

const FILTER = z.object({
  sender: z.string().trim().max(200).optional(),
  category: z.enum(['action', 'waiting', 'calendar', 'money', 'travel', 'people', 'noise']).optional(),
  keyword: z.string().trim().max(200).optional(),
  priority: z.enum(['now', 'soon', 'later']).optional(),
  account: z.string().trim().max(120).optional(),
  importantPeopleOnly: z.boolean().optional()
});

const TRIGGER = z.discriminatedUnion('type', [
  z.object({ type: z.literal('new_email') }),
  z.object({ type: z.literal('schedule'), kind: z.enum(['daily', 'weekly']), at: z.string().regex(/^\d{1,2}:\d{2}$/), weekday: z.number().int().min(0).max(6).optional() }),
  z.object({ type: z.literal('deadline'), withinHours: z.number().int().min(1).max(24 * 30) })
]);

const ACTION = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_task'), title: z.string().trim().min(1).max(160), priority: z.enum(['now', 'soon', 'later']).optional() }),
  z.object({ kind: z.literal('draft_reply'), template: z.enum(['acknowledge', 'meeting', 'follow_up']).default('acknowledge') }),
  z.object({ kind: z.literal('remind'), title: z.string().trim().max(160).optional(), afterHours: z.number().int().min(1).max(24 * 30).default(24) }),
  z.object({ kind: z.literal('notify'), title: z.string().trim().max(160).optional() }),
  z.object({ kind: z.literal('track_commitment'), direction: z.enum(['i_owe', 'they_owe']).default('they_owe') })
]);

export const SCOPES = ['brief', 'unresolved', 'bills_due', 'waiting_on', 'no_response'] as const;
export type Scope = (typeof SCOPES)[number];

export const automationInput = z.object({
  name: z.string().trim().min(1).max(100),
  recipe: z.string().max(60).optional(),
  enabled: z.boolean().default(true),
  trigger: TRIGGER,
  filter: FILTER.default({}),
  scope: z.enum(SCOPES).optional(),
  actions: z.array(ACTION).min(1).max(5),
  approval: z.enum(['always_ask', 'external_only', 'auto']).default('always_ask'),
  dryRun: z.boolean().default(false),
  maxRunsPerDay: z.number().int().min(1).max(100).default(10),
  notifyOnFailure: z.boolean().default(true)
});

export type AutomationInput = z.infer<typeof automationInput>;
export type AutomationAction = z.infer<typeof ACTION>;

export interface Automation extends Owned, AutomationInput {
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunStatus?: 'ran' | 'no_matches' | 'failed' | 'skipped';
  lastRunNote?: string;
  runCount: number;
  /** Recently handled item keys, so a ticking schedule never repeats the same item. */
  firedKeys: string[];
}

export const automationStore = new Collection<Automation>('automations');

// ---- starter recipes ---------------------------------------------------------------------------------------

export interface Recipe {
  id: string;
  name: string;
  summary: string;
  input: AutomationInput;
}

const base = { enabled: false, filter: {}, approval: 'always_ask', dryRun: false, maxRunsPerDay: 10, notifyOnFailure: true } as const;

export const RECIPES: Recipe[] = [
  { id: 'morning-brief', name: 'Morning brief', summary: 'Every morning, a short digest of focus items, follow-ups due and waiting approvals.', input: { ...base, name: 'Morning brief', recipe: 'morning-brief', trigger: { type: 'schedule', kind: 'daily', at: '08:00' }, scope: 'brief', actions: [{ kind: 'notify' }], approval: 'external_only' } },
  { id: 'end-of-day', name: 'End-of-day unresolved items', summary: 'Late afternoon: what is still open and what needs a reply.', input: { ...base, name: 'End-of-day unresolved items', recipe: 'end-of-day', trigger: { type: 'schedule', kind: 'daily', at: '17:30' }, scope: 'unresolved', actions: [{ kind: 'notify' }], approval: 'external_only' } },
  { id: 'bills-due', name: 'Bills due within five days', summary: 'Daily check that adds a reminder for bills and renewals about to come due.', input: { ...base, name: 'Bills due within five days', recipe: 'bills-due', trigger: { type: 'schedule', kind: 'daily', at: '09:00' }, scope: 'bills_due', actions: [{ kind: 'remind', afterHours: 1 }, { kind: 'notify' }], approval: 'external_only' } },
  { id: 'travel-changes', name: 'Travel changes', summary: 'When a travel email arrives, add a review task and alert you.', input: { ...base, name: 'Travel changes', recipe: 'travel-changes', trigger: { type: 'new_email' }, filter: { category: 'travel' }, actions: [{ kind: 'create_task', title: 'Review travel change: {title}', priority: 'now' }, { kind: 'notify', title: 'Travel update: {title}' }], approval: 'external_only' } },
  { id: 'no-response', name: 'No response after four days', summary: 'Drafts a polite follow-up when someone you are waiting on has gone quiet.', input: { ...base, name: 'No response after four days', recipe: 'no-response', trigger: { type: 'schedule', kind: 'daily', at: '10:00' }, scope: 'no_response', actions: [{ kind: 'draft_reply', template: 'follow_up' }] } },
  { id: 'meeting-request', name: 'Meeting-request draft', summary: 'When an email asks to meet, prepare a reply that offers to find a time.', input: { ...base, name: 'Meeting-request draft', recipe: 'meeting-request', trigger: { type: 'new_email' }, filter: { keyword: 'meet|call|catch up|availability|schedule a time' }, actions: [{ kind: 'draft_reply', template: 'meeting' }] } },
  { id: 'weekly-waiting-on', name: 'Weekly waiting-on review', summary: 'Monday morning: what may be falling through the cracks.', input: { ...base, name: 'Weekly waiting-on review', recipe: 'weekly-waiting-on', trigger: { type: 'schedule', kind: 'weekly', at: '09:00', weekday: 1 }, scope: 'waiting_on', actions: [{ kind: 'notify' }], approval: 'external_only' } },
  { id: 'important-person', name: 'Important-person alert', summary: 'Alerts you immediately when someone from your priority list writes.', input: { ...base, name: 'Important-person alert', recipe: 'important-person', trigger: { type: 'new_email' }, filter: { importantPeopleOnly: true }, actions: [{ kind: 'notify', title: 'From {sender}: {title}' }], approval: 'external_only' } }
];

// ---- persistence -------------------------------------------------------------------------------------------

export async function computeNextRun(input: Pick<AutomationInput, 'trigger'>, userId: string, now = new Date()): Promise<string | undefined> {
  if (input.trigger.type !== 'schedule') return undefined;
  const { timezone } = await getAgentSettings(userId);
  const next = input.trigger.kind === 'daily' ? nextDailyRun(now, input.trigger.at, timezone) : nextWeeklyRun(now, input.trigger.weekday ?? 1, input.trigger.at, timezone);
  return next.toISOString();
}

function ensureShape(input: AutomationInput): void {
  if (input.trigger.type === 'new_email' && input.scope) throw new ActionableError('A scope only applies to scheduled automations.', { action: 'Remove the scope.' });
  if (input.trigger.type !== 'new_email' && !input.scope) throw new ActionableError('Scheduled automations need something to look at.', { action: 'Choose what this automation should review.' });
  if (input.trigger.type === 'deadline' && input.scope !== 'bills_due') throw new ActionableError('Deadline automations review bills and due items.', { action: 'Use the “bills due” scope.' });
}

export async function createAutomation(userId: string, raw: unknown, now = new Date()): Promise<Automation> {
  const input = automationInput.parse(raw);
  ensureShape(input);
  const automation: Automation = { ...input, id: crypto.randomUUID(), userId, createdAt: now.toISOString(), updatedAt: now.toISOString(), runCount: 0, firedKeys: [], nextRunAt: input.enabled ? await computeNextRun(input, userId, now) : undefined };
  return (await automationStore.insert(automation)).item;
}

export async function updateAutomation(userId: string, id: string, raw: unknown, now = new Date()): Promise<Automation | null> {
  const current = await automationStore.get(userId, id);
  if (!current) return null;
  const input = automationInput.parse({ ...stripMeta(current), ...(raw as object) });
  ensureShape(input);
  return automationStore.update(userId, id, { ...input, updatedAt: now.toISOString(), nextRunAt: input.enabled ? await computeNextRun(input, userId, now) : undefined });
}

function stripMeta(automation: Automation): AutomationInput {
  const { id: _id, userId: _userId, createdAt: _createdAt, updatedAt: _updatedAt, nextRunAt: _nextRunAt, lastRunAt: _lastRunAt, lastRunStatus: _status, lastRunNote: _note, runCount: _count, firedKeys: _keys, ...input } = automation;
  return input;
}

export const listAutomations = (userId: string) => automationStore.list(userId, { order: 'asc' });
export const getAutomation = (userId: string, id: string) => automationStore.get(userId, id);
export const deleteAutomation = (userId: string, id: string) => automationStore.delete(userId, id);

export async function createFromRecipe(userId: string, recipeId: string, enabled = false): Promise<Automation> {
  const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
  if (!recipe) throw new ActionableError('That starter recipe does not exist.', { action: 'Choose one from the list.' });
  return createAutomation(userId, { ...recipe.input, enabled });
}

// ---- matching ----------------------------------------------------------------------------------------------

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? '');

export function matchesFilter(filter: AutomationInput['filter'], signal: Signal, importantPerson: boolean): boolean {
  if (signal.metadata?.direction === 'outbound') return false;
  if (filter.category && signal.category !== filter.category) return false;
  if (filter.priority && signal.priority !== filter.priority) return false;
  if (filter.account && String(signal.metadata?.account ?? '').toLowerCase() !== filter.account.toLowerCase()) return false;
  if (filter.sender && !`${signal.sender} ${signal.metadata?.fromAddress ?? ''}`.toLowerCase().includes(filter.sender.toLowerCase())) return false;
  if (filter.importantPeopleOnly && !importantPerson) return false;
  if (filter.keyword) {
    const haystack = `${signal.title} ${signal.summary}`.toLowerCase();
    let hit: boolean;
    try {
      hit = new RegExp(filter.keyword, 'i').test(haystack);
    } catch {
      hit = haystack.includes(filter.keyword.toLowerCase());
    }
    if (!hit) return false;
  }
  return true;
}

// ---- execution ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

async function runsToday(userId: string, automationId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  return (await runStore.list(userId, { limit: 500 })).filter((run) => run.automationId === automationId && run.createdAt >= cutoff).length;
}

export async function canRunAutomation(userId: string, automation: Automation, now = new Date()): Promise<{ ok: boolean; reason?: string }> {
  const limits = agentLimits();
  const settings = await getAgentSettings(userId);
  if (!limits.enabled || !limits.automationsEnabled) return { ok: false, reason: 'Automations are disabled on this installation.' };
  if (settings.paused) return { ok: false, reason: 'The agent is paused.' };
  if (settings.automationsKilled) return { ok: false, reason: 'The automations kill switch is on.' };
  if (!automation.enabled) return { ok: false, reason: 'This automation is turned off.' };
  if ((await runsToday(userId, automation.id, now)) >= automation.maxRunsPerDay) return { ok: false, reason: `Reached its limit of ${automation.maxRunsPerDay} runs in 24 hours.` };
  return { ok: true };
}

async function notifyFailure(userId: string, automation: Automation, error: unknown): Promise<void> {
  if (!automation.notifyOnFailure) return;
  const message = error instanceof Error ? error.message : 'Unknown error';
  await createNotification(userId, { title: `Automation “${automation.name}” failed`, body: `${message}\nOpen Automations to review it.`, kind: 'failure' }).catch(() => undefined);
}

interface Item { key: string; title: string; signalId?: string; taskId?: string; commitmentId?: string; dueAt?: string; person?: string; email?: string; action?: string; threadSignalId?: string; followUps?: number }

async function billItems(userId: string, now: Date, days = 5): Promise<Item[]> {
  const [tasks, signals] = await Promise.all([getTasks(userId), getSignals(userId)]);
  const money = new Set(signals.filter((signal) => signal.category === 'money').map((signal) => signal.id));
  const limit = new Date(now.getTime() + days * DAY_MS).toISOString();
  return tasks
    .filter((task) => task.status === 'open' && task.dueAt && task.dueAt <= limit && task.dueAt >= new Date(now.getTime() - DAY_MS).toISOString() && ((task.sourceSignalId && money.has(task.sourceSignalId)) || /invoice|bill|payment|renewal|subscription|rent|premium/i.test(task.title)))
    .map((task) => ({ key: `bill:${task.id}:${String(task.dueAt).slice(0, 10)}`, title: task.title, taskId: task.id, signalId: task.sourceSignalId, dueAt: String(task.dueAt) }));
}

async function noResponseItems(userId: string, now: Date, days = 4): Promise<Item[]> {
  const open = await listCommitments(userId, { status: ['open', 'snoozed'], direction: 'they_owe' });
  return open
    .filter((item) => (item.followUpAt ?? item.expectedAt ?? '9') <= now.toISOString() && new Date(item.createdAt).getTime() <= now.getTime() - days * DAY_MS + DAY_MS)
    .map((item) => ({ key: `noresp:${item.id}:${item.followUpCount ?? 0}`, title: `${item.otherPerson}: ${item.action}`, commitmentId: item.id, signalId: item.evidenceSignalId, person: item.otherPerson, email: item.otherEmail, action: item.action, followUps: item.followUpCount ?? 0 }));
}

async function digestFor(scope: Scope, userId: string, now: Date): Promise<Digest | null> {
  const { timezone } = await getAgentSettings(userId);
  if (scope === 'brief') return morningBrief(userId, now, timezone);
  if (scope === 'unresolved') return endOfDay(userId, now);
  if (scope === 'waiting_on') return weeklyWaitingOn(userId, now);
  return null;
}

async function callsForSignal(userId: string, automation: Automation, signal: Signal): Promise<PlannedCall[]> {
  const calls: PlannedCall[] = [];
  const vars = { title: signal.title, sender: displayName(signal.sender), summary: signal.summary };
  const channels = await ownerChannels(userId);
  const user = await getUser(userId);
  for (const action of automation.actions) {
    if (action.kind === 'create_task') calls.push({ tool: 'create_task', input: { title: fill(action.title, vars), priority: action.priority ?? signal.priority, sourceSignalId: signal.id }, reason: `Automation “${automation.name}” matched this message.`, sourceSignalId: signal.id });
    else if (action.kind === 'remind') calls.push({ tool: 'create_reminder', input: { title: fill(action.title ?? 'Follow up: {title}', vars), remindAt: new Date(Date.now() + action.afterHours * 3_600_000).toISOString(), signalId: signal.id }, reason: `Automation “${automation.name}” matched this message.`, sourceSignalId: signal.id });
    else if (action.kind === 'notify') calls.push({ tool: 'notify_owner', input: { title: fill(action.title ?? '{title}', vars).slice(0, 160), body: `${vars.sender}: ${signal.summary}`, channels, kind: 'alert', dedupe: `auto:${automation.id}:${signal.id}` }, reason: `Automation “${automation.name}” matched this message.`, sourceSignalId: signal.id });
    else if (action.kind === 'track_commitment') calls.push({ tool: 'mark_waiting_on', input: { signalId: signal.id, direction: action.direction, otherPerson: vars.sender, otherEmail: typeof signal.metadata?.fromAddress === 'string' ? signal.metadata.fromAddress : extractEmail(signal.sender), action: signal.title, threadId: signal.metadata?.threadId }, reason: `Automation “${automation.name}” matched this message.`, sourceSignalId: signal.id });
    else if (action.kind === 'draft_reply') {
      const settings = await getSettings(userId);
      const draft = action.template === 'meeting' ? { body: `Hi ${vars.sender.split(/\s+/)[0] || 'there'},\n\nHappy to find a time. Could you share a couple of windows that work for you? I’ll confirm one.\n\nBest,\n${(user?.name ?? '').split(/\s+/)[0]}`.trim(), generatedBy: 'rules' as const } : await composeDraft({ ownerName: user?.name ?? '', signal, kind: action.template === 'follow_up' ? 'follow_up' : 'reply', preferences: (await shareableMemories(userId)).filter((memory) => memory.type === 'communication_preference').map((memory) => memory.statement), settings, userId });
      calls.push({ tool: 'draft_reply', input: { signalId: signal.id, body: draft.body, kind: action.template === 'follow_up' ? 'follow_up' : 'reply', round: 1 }, reason: `Automation “${automation.name}” matched this message.`, sourceSignalId: signal.id, generatedBy: draft.generatedBy });
    }
  }
  return calls;
}

async function callsForItems(userId: string, automation: Automation, items: Item[], now: Date): Promise<PlannedCall[]> {
  const calls: PlannedCall[] = [];
  const channels = await ownerChannels(userId);
  for (const action of automation.actions) {
    if (action.kind === 'remind') {
      for (const item of items) calls.push({ tool: 'create_reminder', input: { title: fill(action.title ?? 'Due soon: {title}', { title: item.title }), remindAt: new Date(now.getTime() + action.afterHours * 3_600_000).toISOString(), taskId: item.taskId, signalId: item.signalId, commitmentId: item.commitmentId }, reason: `Automation “${automation.name}” found: ${item.title}` });
    } else if (action.kind === 'notify' && items.length) {
      calls.push({ tool: 'notify_owner', input: { title: fill(action.title ?? automation.name, { title: automation.name }), body: items.map((item) => `• ${item.title}${item.dueAt ? ` (due ${item.dueAt.slice(0, 10)})` : ''}`).join('\n'), channels, kind: 'alert', dedupe: `auto:${automation.id}:${items.map((item) => item.key).join('|').slice(0, 80)}` }, reason: `Automation “${automation.name}” found ${items.length} item${items.length === 1 ? '' : 's'}.` });
    } else if (action.kind === 'draft_reply') {
      for (const item of items.filter((candidate) => candidate.commitmentId)) {
        const call = await followUpCall(userId, item.commitmentId!);
        if (call) calls.push({ ...call, reason: `${item.person ?? 'They'} has not replied about “${item.action}”.` });
      }
    } else if (action.kind === 'create_task') {
      for (const item of items) calls.push({ tool: 'create_task', input: { title: fill(action.title, { title: item.title }), priority: action.priority ?? 'soon', dueAt: item.dueAt, sourceSignalId: item.signalId }, reason: `Automation “${automation.name}” found: ${item.title}`, sourceSignalId: item.signalId });
    }
  }
  return calls;
}

async function recordRun(userId: string, automation: Automation, patch: Partial<Automation>, now: Date): Promise<void> {
  await automationStore.update(userId, automation.id, { lastRunAt: now.toISOString(), updatedAt: now.toISOString(), ...patch });
}

/** Runs one automation for the given trigger context. Returns the number of proposals created. */
async function execute(userId: string, automation: Automation, context: { signal?: Signal; now: Date; forceDryRun?: boolean }): Promise<number> {
  const { now } = context;
  const gate = await canRunAutomation(userId, automation, now);
  if (!gate.ok) {
    await recordRun(userId, automation, { lastRunStatus: 'skipped', lastRunNote: gate.reason }, now);
    return 0;
  }
  try {
    let calls: PlannedCall[] = [];
    let newKeys: string[] = [];
    if (context.signal) {
      calls = await callsForSignal(userId, automation, context.signal);
    } else if (automation.scope) {
      if (automation.scope === 'bills_due' || automation.scope === 'no_response') {
        const items = (automation.scope === 'bills_due' ? await billItems(userId, now, automation.trigger.type === 'deadline' ? Math.max(1, automation.trigger.withinHours / 24) : 5) : await noResponseItems(userId, now)).filter((item) => !automation.firedKeys.includes(item.key));
        calls = await callsForItems(userId, automation, items, now);
        newKeys = items.map((item) => item.key);
      } else {
        const digest = await digestFor(automation.scope, userId, now);
        const notify = automation.actions.find((action) => action.kind === 'notify');
        if (digest && notify) calls = [{ tool: 'notify_owner', input: { title: digest.title, body: digest.body, channels: await ownerChannels(userId), kind: 'digest', dedupe: `auto:${automation.id}:${now.toISOString().slice(0, 13)}` }, reason: `Scheduled automation “${automation.name}”.` }];
      }
    }
    if (!calls.length) {
      await recordRun(userId, automation, { lastRunStatus: 'no_matches', lastRunNote: 'Nothing to do this time.' }, now);
      return 0;
    }
    const run = await startRun(userId, { objective: `Automation: ${automation.name}`, trigger: { type: 'automation', ref: automation.id, label: automation.name }, plan: [`Run “${automation.name}”.`, automation.dryRun || context.forceDryRun ? 'Dry run: show what would happen without changing anything.' : `Approval mode: ${describeApproval(automation.approval)}.`], automationId: automation.id, dryRun: automation.dryRun || !!context.forceDryRun }, now);
    const result = await proposeCalls(userId, run, calls, { automationApproval: automation.approval as AutomationApproval });
    if (automation.scope === 'no_response' && !run.dryRun) for (const key of newKeys) { const id = key.split(':')[1]; if (id) await bumpFollowUp(userId, id, now); }
    await recordRun(userId, automation, { lastRunStatus: 'ran', lastRunNote: `${result.proposals.length} proposed, ${result.duplicates.length} already handled.`, runCount: automation.runCount + 1, firedKeys: [...automation.firedKeys, ...newKeys].slice(-200) }, now);
    return result.proposals.length;
  } catch (error) {
    logSafe(`automation ${automation.name}`, error);
    await recordRun(userId, automation, { lastRunStatus: 'failed', lastRunNote: error instanceof Error ? error.message.slice(0, 200) : 'Unknown error' }, now);
    await notifyFailure(userId, automation, error);
    return 0;
  }
}

const describeApproval = (approval: Automation['approval']) => (approval === 'always_ask' ? 'always ask' : approval === 'external_only' ? 'ask only for external changes' : 'automatic where allowed');

/** Evaluates `new_email` automations against freshly synced signals. */
export async function runSignalAutomations(userId: string, signals: Signal[], now = new Date()): Promise<number> {
  if (!signals.length) return 0;
  const [automations, memories] = await Promise.all([automationStore.list(userId, { where: { enabled: true } }), listMemories(userId, { enabledOnly: true })]);
  let proposals = 0;
  for (const automation of automations.filter((candidate) => candidate.trigger.type === 'new_email')) {
    for (const signal of signals) {
      if (!matchesFilter(automation.filter, signal, isImportantPerson(memories, `${signal.sender} ${signal.metadata?.fromAddress ?? ''}`))) continue;
      const fresh = (await automationStore.get(userId, automation.id)) ?? automation;
      proposals += await execute(userId, fresh, { signal, now });
    }
  }
  return proposals;
}

/** Runs schedule and deadline automations that are due. Safe to call from several instances at once. */
export async function runDueAutomations(now = new Date()): Promise<number> {
  const all = await automationStore.listAllOwners({ where: { enabled: true } });
  let ran = 0;
  for (const automation of all) {
    const { userId } = automation;
    if (automation.trigger.type === 'schedule') {
      if (!automation.nextRunAt || automation.nextRunAt > now.toISOString()) continue;
      const nextRunAt = await computeNextRun(automation, userId, now);
      // Claim this occurrence first: a second instance sees the advanced nextRunAt and skips it.
      const claimed = await claimOccurrence(userId, automation, nextRunAt);
      if (!claimed) continue;
      await execute(userId, claimed, { now });
      ran += 1;
    } else if (automation.trigger.type === 'deadline') {
      await execute(userId, automation, { now });
      ran += 1;
    }
  }
  return ran;
}

/** Claims one occurrence atomically: only the instance whose compare-and-set succeeds runs it. */
async function claimOccurrence(userId: string, automation: Automation, nextRunAt: string | undefined): Promise<Automation | null> {
  return automationStore.updateIf(userId, automation.id, { nextRunAt: automation.nextRunAt as string }, { nextRunAt });
}

/** Manual "Run now" and "Dry run" from the UI. */
export async function runAutomationNow(userId: string, id: string, options: { dryRun?: boolean } = {}, now = new Date()): Promise<{ proposals: number }> {
  const automation = await automationStore.get(userId, id);
  if (!automation) throw new ActionableError('That automation no longer exists.', { action: 'Refresh Automations.' });
  if (automation.trigger.type === 'new_email') {
    const memories = await listMemories(userId, { enabledOnly: true });
    const signal = (await getSignals(userId)).find((candidate) => matchesFilter(automation.filter, candidate, isImportantPerson(memories, `${candidate.sender} ${candidate.metadata?.fromAddress ?? ''}`)));
    if (!signal) throw new ActionableError('No stored message matches this automation yet, so there is nothing to test.', { action: 'Wait for a matching email, or loosen the conditions.' });
    return { proposals: await execute(userId, { ...automation, enabled: true }, { signal, now, forceDryRun: options.dryRun }) };
  }
  return { proposals: await execute(userId, { ...automation, enabled: true, firedKeys: options.dryRun ? [] : automation.firedKeys }, { now, forceDryRun: options.dryRun }) };
}

export async function failAutomationRun(userId: string, runId: string, error: unknown): Promise<void> {
  await failRun(userId, runId, { code: 'automation_failed', message: error instanceof Error ? error.message.slice(0, 200) : 'Automation failed', action: 'Open Automations and review its settings.' });
}
