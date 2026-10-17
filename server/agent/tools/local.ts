import { z } from 'zod';
import { ActionableError } from '../../diagnostics.js';
import { createTask, deleteTask, getSignal, getSignals, getTask, getTasks, patchSignal, patchTask } from '../../store.js';
import { createCommitment, getCommitment, listCommitments, resolveCommitment, reopenCommitment, snoozeCommitment, commitments } from '../commitments.js';
import { createMemory, deleteMemory } from '../memory.js';
import { createReminder, reminders } from '../reminders.js';
import { displayName, extractEmail, id, isoDate, priority, slug } from './util.js';
import { registerTool, type AnyTool } from './registry.js';

async function requireSignal(userId: string, signalId: string) {
  const signal = await getSignal(userId, signalId);
  if (!signal) throw new ActionableError('That message is no longer in Orbit.', { action: 'Sync again, or choose a different item.', code: 'signal_missing' });
  return signal;
}

async function requireTask(userId: string, taskId: string) {
  const task = await getTask(userId, taskId);
  if (!task) throw new ActionableError('That task no longer exists.', { action: 'Refresh your focus queue.', code: 'task_missing' });
  return task;
}

const stateOf = (signal: { metadata?: Record<string, unknown> }) => (signal.metadata?.state ?? {}) as Record<string, unknown>;

// ---- read tools --------------------------------------------------------------------------------------------

const searchSignals: AnyTool = {
  name: 'search_signals',
  description: 'Search stored message summaries by words, category or sender. Read-only.',
  risk: 'read',
  schema: z.object({ query: z.string().max(200).default(''), category: z.enum(['action', 'waiting', 'calendar', 'money', 'travel', 'people', 'noise']).optional(), limit: z.number().int().min(1).max(25).default(10) }),
  preview: async () => ({ title: 'Search messages', description: 'Reads stored summaries inside Orbit.', dataLeaving: [], services: [] }),
  dedupeKey: (input, ctx) => `run:${ctx.runId}:search:${slug(input.query)}`,
  execute: async (input, ctx) => {
    const terms = String(input.query).toLowerCase().split(/\W+/).filter((term) => term.length > 2);
    const rows = (await getSignals(ctx.userId))
      .filter((signal) => signal.metadata?.direction !== 'outbound' && (!input.category || signal.category === input.category))
      .filter((signal) => !terms.length || terms.some((term) => `${signal.title} ${signal.summary} ${signal.sender}`.toLowerCase().includes(term)))
      .slice(0, input.limit);
    return { summary: `Found ${rows.length} matching message${rows.length === 1 ? '' : 's'}.`, output: { signals: rows.map((signal) => ({ id: signal.id, title: signal.title, sender: signal.sender, priority: signal.priority, category: signal.category, summary: signal.summary })) } };
  }
};

const listWaitingOn: AnyTool = {
  name: 'list_waiting_on',
  description: 'List open commitments, optionally only what other people owe the owner. Read-only.',
  risk: 'read',
  schema: z.object({ direction: z.enum(['i_owe', 'they_owe']).optional() }),
  preview: async () => ({ title: 'List waiting-on items', description: 'Reads commitments stored in Orbit.', dataLeaving: [], services: [] }),
  dedupeKey: (input, ctx) => `run:${ctx.runId}:waiting:${input.direction ?? 'all'}`,
  execute: async (input, ctx) => {
    const rows = await listCommitments(ctx.userId, { status: ['open', 'snoozed'], direction: input.direction });
    return { summary: `${rows.length} open commitment${rows.length === 1 ? '' : 's'}.`, output: { commitments: rows.map((row) => ({ id: row.id, direction: row.direction, person: row.otherPerson, action: row.action, expectedAt: row.expectedAt })) } };
  }
};

const listTasks: AnyTool = {
  name: 'list_tasks',
  description: 'List tasks. Read-only.',
  risk: 'read',
  schema: z.object({ status: z.enum(['open', 'done', 'snoozed']).default('open'), travelOnly: z.boolean().default(false) }),
  preview: async () => ({ title: 'List tasks', description: 'Reads tasks stored in Orbit.', dataLeaving: [], services: [] }),
  dedupeKey: (input, ctx) => `run:${ctx.runId}:tasks:${input.status}:${input.travelOnly}`,
  execute: async (input, ctx) => {
    const signals = new Map((await getSignals(ctx.userId)).map((signal) => [signal.id, signal]));
    const rows = (await getTasks(ctx.userId)).filter((task) => task.status === input.status && (!input.travelOnly || (task.sourceSignalId && signals.get(task.sourceSignalId)?.category === 'travel') || /flight|hotel|trip|travel/i.test(task.title)));
    return { summary: `${rows.length} task${rows.length === 1 ? '' : 's'}.`, output: { tasks: rows.map((task) => ({ id: task.id, title: task.title, dueAt: task.dueAt, priority: task.priority })) } };
  }
};

// ---- local write tools -------------------------------------------------------------------------------------

const createTaskTool: AnyTool = {
  name: 'create_task',
  description: 'Create a task in Orbit’s focus queue.',
  risk: 'local',
  schema: z.object({ title: z.string().trim().min(1).max(200), note: z.string().max(1000).optional(), dueAt: isoDate.optional(), priority: priority.default('soon'), sourceSignalId: id.optional() }),
  authorize: async (input, ctx) => { if (input.sourceSignalId) await requireSignal(ctx.userId, input.sourceSignalId); },
  preview: async (input) => ({ title: `Create task “${input.title}”`, description: `Adds a ${input.priority} priority task${input.dueAt ? ` due ${input.dueAt.slice(0, 10)}` : ''} to your focus queue.`, dataLeaving: [], services: [], editable: ['title', 'dueAt', 'priority'] }),
  dedupeKey: (input, ctx) => (input.sourceSignalId ? `signal:${input.sourceSignalId}:${slug(input.title)}` : `run:${ctx.runId}:${slug(input.title)}:${input.dueAt?.slice(0, 10) ?? ''}`),
  execute: async (input, ctx) => {
    const task = await createTask(ctx.userId, { title: input.title, note: input.note, dueAt: input.dueAt, priority: input.priority, source: 'manual', sourceSignalId: input.sourceSignalId });
    return { summary: `Created task “${task.title}”.`, output: { taskId: task.id }, undoable: true };
  },
  verify: async (_input, outcome, ctx) => ({ ok: !!(await getTask(ctx.userId, String(outcome.output.taskId))), detail: 'Task exists in the focus queue.' }),
  undo: async (_input, outcome, ctx) => { await deleteTask(ctx.userId, String(outcome.output.taskId)); return { summary: 'Removed the task Orbit created.' }; }
};

const updateTaskTool: AnyTool = {
  name: 'update_task',
  description: 'Change a task’s title, due date, priority, note or status.',
  risk: 'local',
  schema: z.object({ taskId: id, title: z.string().trim().min(1).max(200).optional(), note: z.string().max(1000).optional(), dueAt: isoDate.optional(), priority: priority.optional(), status: z.enum(['open', 'done', 'snoozed']).optional() })
    .refine((value) => ['title', 'note', 'dueAt', 'priority', 'status'].some((key) => (value as Record<string, unknown>)[key] !== undefined), 'Provide at least one field to change'),
  authorize: async (input, ctx) => { await requireTask(ctx.userId, input.taskId); },
  preview: async (input, ctx) => {
    const task = await requireTask(ctx.userId, input.taskId);
    const changes = (['title', 'note', 'dueAt', 'priority', 'status'] as const).filter((key) => input[key] !== undefined).map((key) => `${key}: ${String(input[key]).slice(0, 60)}`);
    return { title: `Update task “${task.title}”`, description: `Changes ${changes.join(', ')}.`, dataLeaving: [], services: [], editable: ['dueAt', 'priority'] };
  },
  dedupeKey: (input, ctx) => `run:${ctx.runId}:update:${input.taskId}:${input.dueAt?.slice(0, 10) ?? ''}:${input.status ?? ''}:${input.priority ?? ''}`,
  execute: async (input, ctx) => {
    const previous = await requireTask(ctx.userId, input.taskId);
    const { taskId, ...patch } = input;
    await patchTask(ctx.userId, taskId, patch);
    return { summary: `Updated task “${previous.title}”.`, output: { taskId, previous: { title: previous.title, note: previous.note ?? null, dueAt: previous.dueAt ?? null, priority: previous.priority, status: previous.status } }, undoable: true };
  },
  verify: async (input, _outcome, ctx) => {
    const task = await getTask(ctx.userId, input.taskId);
    const ok = !!task && (input.dueAt === undefined || task.dueAt?.slice(0, 10) === input.dueAt.slice(0, 10)) && (input.status === undefined || task.status === input.status);
    return { ok, detail: ok ? 'Task now shows the requested values.' : 'Task did not match the requested values.' };
  },
  undo: async (_input, outcome, ctx) => {
    const previous = outcome.output.previous as { title: string; note: string | null; dueAt: string | null; priority: 'now' | 'soon' | 'later'; status: 'open' | 'done' | 'snoozed' };
    await patchTask(ctx.userId, String(outcome.output.taskId), { title: previous.title, note: previous.note ?? undefined, dueAt: previous.dueAt ?? undefined, priority: previous.priority, status: previous.status });
    return { summary: 'Restored the task’s previous values.' };
  }
};

const createReminderTool: AnyTool = {
  name: 'create_reminder',
  description: 'Schedule a reminder that appears in Orbit at a chosen time.',
  risk: 'local',
  schema: z.object({ title: z.string().trim().min(1).max(200), remindAt: isoDate, taskId: id.optional(), signalId: id.optional(), commitmentId: id.optional() }),
  authorize: async (input, ctx) => {
    if (input.signalId) await requireSignal(ctx.userId, input.signalId);
    if (input.taskId) await requireTask(ctx.userId, input.taskId);
    if (input.commitmentId && !(await getCommitment(ctx.userId, input.commitmentId))) throw new ActionableError('That commitment no longer exists.', { action: 'Refresh Waiting On.' });
  },
  preview: async (input) => ({ title: `Remind you: “${input.title}”`, description: `A reminder will appear in Orbit on ${input.remindAt.slice(0, 16).replace('T', ' ')} UTC.`, dataLeaving: [], services: [], editable: ['title', 'remindAt'] }),
  dedupeKey: (input, ctx) => `reminder:${input.commitmentId ?? input.signalId ?? input.taskId ?? ctx.runId}:${input.remindAt.slice(0, 10)}:${slug(input.title, 24)}`,
  execute: async (input, ctx) => {
    const { reminder } = await createReminder(ctx.userId, input, `exec:${ctx.idempotencyKey}`);
    return { summary: `Reminder set for ${reminder.remindAt.slice(0, 10)}.`, output: { reminderId: reminder.id }, undoable: true };
  },
  verify: async (_input, outcome, ctx) => ({ ok: !!(await reminders.get(ctx.userId, String(outcome.output.reminderId))), detail: 'Reminder is scheduled.' }),
  undo: async (_input, outcome, ctx) => { await reminders.delete(ctx.userId, String(outcome.output.reminderId)); return { summary: 'Removed the reminder.' }; }
};

function signalStateTool(options: { name: string; description: string; title: (signalTitle: string, input: Record<string, unknown>) => string; schema: z.ZodType; state: (input: Record<string, unknown>) => Record<string, unknown>; category?: 'noise'; summaryText: string }): AnyTool {
  return {
    name: options.name,
    description: options.description,
    risk: 'local',
    schema: options.schema,
    authorize: async (input, ctx) => { await requireSignal(ctx.userId, (input as { signalId: string }).signalId); },
    preview: async (input, ctx) => {
      const signal = await requireSignal(ctx.userId, input.signalId);
      return { title: options.title(signal.title, input), description: options.summaryText, dataLeaving: [], services: [] };
    },
    dedupeKey: (input) => `signal:${input.signalId}:${options.name}:${input.until ?? ''}`,
    execute: async (input, ctx) => {
      const signal = await requireSignal(ctx.userId, input.signalId);
      const previous = { category: signal.category, priority: signal.priority, state: stateOf(signal) };
      await patchSignal(ctx.userId, signal.id, { category: options.category, metadata: { state: { ...options.state(input), at: ctx.now.toISOString() } } });
      return { summary: `${options.summaryText}`, output: { signalId: signal.id, previous }, undoable: true };
    },
    verify: async (input, _outcome, ctx) => ({ ok: !!(await getSignal(ctx.userId, input.signalId)), detail: 'Message updated.' }),
    undo: async (_input, outcome, ctx) => {
      const previous = outcome.output.previous as { category: 'action' | 'waiting' | 'calendar' | 'money' | 'travel' | 'people' | 'noise'; priority: 'now' | 'soon' | 'later'; state: Record<string, unknown> };
      await patchSignal(ctx.userId, String(outcome.output.signalId), { category: previous.category, priority: previous.priority, metadata: { state: previous.state } });
      return { summary: 'Restored the message to how it was.' };
    }
  };
}

const markNoise = signalStateTool({ name: 'mark_signal_noise', description: 'Mark a message as noise so it no longer competes for attention.', title: (t) => `Mark “${t}” as noise`, schema: z.object({ signalId: id }), state: () => ({ status: 'open', reason: 'marked_noise' }), category: 'noise', summaryText: 'Moves this message to Quieted.' });
const snoozeSignal = signalStateTool({ name: 'snooze_signal', description: 'Hide a message until a chosen time.', title: (t) => `Snooze “${t}”`, schema: z.object({ signalId: id, until: isoDate }), state: (input) => ({ status: 'snoozed', snoozedUntil: input.until }), summaryText: 'Hides this message until the chosen time, then brings it back.' });
const markResolved = signalStateTool({ name: 'mark_resolved', description: 'Mark a message as resolved.', title: (t) => `Mark “${t}” resolved`, schema: z.object({ signalId: id }), state: () => ({ status: 'resolved' }), summaryText: 'Removes this message from your active inbox.' });

const markWaitingOn: AnyTool = {
  name: 'mark_waiting_on',
  description: 'Track a commitment: something you are waiting on, or something you owe.',
  risk: 'local',
  schema: z.object({
    signalId: id, direction: z.enum(['i_owe', 'they_owe']).default('they_owe'), otherPerson: z.string().trim().min(1).max(120), otherEmail: z.string().max(200).optional(),
    action: z.string().trim().min(1).max(240), expectedAt: isoDate.optional(), evidence: z.string().max(200).optional(), threadId: z.string().max(200).optional(), confidence: z.number().min(0).max(1).optional()
  }),
  authorize: async (input, ctx) => { await requireSignal(ctx.userId, input.signalId); },
  preview: async (input) => ({
    title: input.direction === 'they_owe' ? `Track: ${input.otherPerson} owes you “${input.action}”` : `Track: you owe ${input.otherPerson} “${input.action}”`,
    description: `Orbit will watch for a reply and remind you${input.expectedAt ? ` around ${input.expectedAt.slice(0, 10)}` : ' in a few days'}.`, dataLeaving: [], services: [], editable: ['action', 'expectedAt']
  }),
  dedupeKey: (input) => `signal:${input.signalId}:commit:${input.direction}:${slug(input.action)}`,
  senderEmail: async (input) => input.otherEmail?.toLowerCase(),
  execute: async (input, ctx) => {
    const { commitment } = await createCommitment(ctx.userId, { direction: input.direction, otherPerson: input.otherPerson, otherEmail: input.otherEmail, action: input.action, expectedAt: input.expectedAt, evidenceSignalId: input.signalId, evidence: input.evidence, threadId: input.threadId, confidence: input.confidence }, ctx.now);
    await createReminder(ctx.userId, { title: input.direction === 'they_owe' ? `Follow up with ${input.otherPerson}: ${input.action}` : `You owe ${input.otherPerson}: ${input.action}`, remindAt: commitment.followUpAt ?? commitment.expectedAt!, commitmentId: commitment.id, signalId: input.signalId }, `commit:${commitment.id}`);
    return { summary: `Now tracking “${commitment.action}”.`, output: { commitmentId: commitment.id }, undoable: true };
  },
  verify: async (_input, outcome, ctx) => ({ ok: !!(await getCommitment(ctx.userId, String(outcome.output.commitmentId))), detail: 'Commitment is on your Waiting On list.' }),
  undo: async (_input, outcome, ctx) => {
    await commitments.delete(ctx.userId, String(outcome.output.commitmentId));
    await reminders.deleteWhere(ctx.userId, { commitmentId: String(outcome.output.commitmentId) });
    return { summary: 'Stopped tracking that commitment.' };
  }
};

const resolveCommitmentTool: AnyTool = {
  name: 'resolve_commitment',
  description: 'Close a commitment because it was completed.',
  risk: 'local',
  schema: z.object({ commitmentId: id, resolutionSignalId: id.optional(), evidence: z.string().max(200).optional() }),
  authorize: async (input, ctx) => { if (!(await getCommitment(ctx.userId, input.commitmentId))) throw new ActionableError('That commitment no longer exists.', { action: 'Refresh Waiting On.' }); },
  preview: async (input, ctx) => {
    const item = (await getCommitment(ctx.userId, input.commitmentId))!;
    return { title: `Close “${item.action}”`, description: input.evidence ? `Orbit thinks this was completed: “${input.evidence}”` : 'Marks this commitment as done.', dataLeaving: [], services: [] };
  },
  dedupeKey: (input) => `commitment:${input.commitmentId}:resolve:${input.resolutionSignalId ?? 'manual'}`,
  execute: async (input, ctx) => {
    const closed = await resolveCommitment(ctx.userId, input.commitmentId, input.resolutionSignalId);
    if (!closed) throw new ActionableError('That commitment is already closed.', { action: 'Nothing else to do.', retryable: false });
    return { summary: `Closed “${closed.action}”.`, output: { commitmentId: closed.id }, undoable: true };
  },
  verify: async (input, _outcome, ctx) => ({ ok: (await getCommitment(ctx.userId, input.commitmentId))?.status === 'resolved', detail: 'Commitment is closed.' }),
  undo: async (input, _outcome, ctx) => { await reopenCommitment(ctx.userId, input.commitmentId); return { summary: 'Reopened the commitment.' }; }
};

const snoozeCommitmentTool: AnyTool = {
  name: 'snooze_commitment',
  description: 'Postpone a commitment follow-up.',
  risk: 'local',
  schema: z.object({ commitmentId: id, until: isoDate }),
  authorize: async (input, ctx) => { if (!(await getCommitment(ctx.userId, input.commitmentId))) throw new ActionableError('That commitment no longer exists.', { action: 'Refresh Waiting On.' }); },
  preview: async (input, ctx) => ({ title: `Snooze “${(await getCommitment(ctx.userId, input.commitmentId))!.action}”`, description: `Follow-up moves to ${input.until.slice(0, 10)}.`, dataLeaving: [], services: [] }),
  dedupeKey: (input, ctx) => `run:${ctx.runId}:snooze:${input.commitmentId}:${input.until.slice(0, 10)}`,
  execute: async (input, ctx) => {
    const updated = await snoozeCommitment(ctx.userId, input.commitmentId, input.until);
    if (!updated) throw new ActionableError('That commitment is closed.', { action: 'Nothing else to do.' });
    return { summary: `Snoozed until ${input.until.slice(0, 10)}.`, output: { commitmentId: updated.id } };
  }
};

const ignoreSender: AnyTool = {
  name: 'ignore_sender',
  description: 'Stop surfacing messages from a sender.',
  risk: 'local',
  schema: z.object({ senderEmail: z.string().max(200), signalId: id.optional() }),
  authorize: async (input, ctx) => { if (!extractEmail(input.senderEmail)) throw new ActionableError('That is not an email address.', { action: 'Enter a full address.' }); if (input.signalId) await requireSignal(ctx.userId, input.signalId); },
  preview: async (input) => ({ title: `Ignore ${extractEmail(input.senderEmail)}`, description: 'Future messages from this sender are quieted. You can remove the rule in Memory.', dataLeaving: [], services: [] }),
  dedupeKey: (input) => `ignore:${extractEmail(input.senderEmail)}`,
  senderEmail: async (input) => extractEmail(input.senderEmail),
  execute: async (input, ctx) => {
    const email = extractEmail(input.senderEmail)!;
    const { memory } = await createMemory(ctx.userId, { type: 'inbox_rule', statement: `Messages from ${email} are ignored.`, params: { action: 'ignore', senderEmail: email }, source: { kind: 'agent', ref: ctx.runId } });
    if (input.signalId) await patchSignal(ctx.userId, input.signalId, { category: 'noise' });
    return { summary: `Ignoring ${email}.`, output: { memoryId: memory.id }, undoable: true };
  },
  undo: async (_input, outcome, ctx) => { await deleteMemory(ctx.userId, String(outcome.output.memoryId)); return { summary: 'Stopped ignoring that sender.' }; }
};

const addPriorityPerson: AnyTool = {
  name: 'add_priority_person',
  description: 'Treat a sender as a priority person.',
  risk: 'local',
  schema: z.object({ email: z.string().max(200), name: z.string().max(120).optional() }),
  authorize: async (input) => { if (!extractEmail(input.email)) throw new ActionableError('That is not an email address.', { action: 'Enter a full address.' }); },
  preview: async (input) => ({ title: `Prioritize ${displayName(input.name ?? input.email)}`, description: `Messages from ${extractEmail(input.email)} will be treated as high priority. You can edit this in Memory.`, dataLeaving: [], services: [] }),
  dedupeKey: (input) => `priority:${extractEmail(input.email)}`,
  senderEmail: async (input) => extractEmail(input.email),
  execute: async (input, ctx) => {
    const email = extractEmail(input.email)!;
    const { memory } = await createMemory(ctx.userId, { type: 'important_person', statement: `Messages from ${email} are high priority.`, params: { email, name: input.name ?? '' }, source: { kind: 'agent', ref: ctx.runId } });
    return { summary: `${email} is now a priority person.`, output: { memoryId: memory.id }, undoable: true };
  },
  undo: async (_input, outcome, ctx) => { await deleteMemory(ctx.userId, String(outcome.output.memoryId)); return { summary: 'Removed the priority rule.' }; }
};

const extractDeadline: AnyTool = {
  name: 'extract_deadline',
  description: 'Attach a deadline to a message by creating or updating its task.',
  risk: 'local',
  schema: z.object({ signalId: id, dueAt: isoDate, label: z.string().max(160).optional() }),
  authorize: async (input, ctx) => { await requireSignal(ctx.userId, input.signalId); },
  preview: async (input, ctx) => {
    const signal = await requireSignal(ctx.userId, input.signalId);
    return { title: `Set deadline for “${signal.title}”`, description: `Due ${input.dueAt.slice(0, 10)}${input.label ? ` — ${input.label}` : ''}. Creates a task, or updates the existing one.`, dataLeaving: [], services: [], editable: ['dueAt'] };
  },
  dedupeKey: (input) => `signal:${input.signalId}:deadline:${input.dueAt.slice(0, 10)}`,
  execute: async (input, ctx) => {
    const signal = await requireSignal(ctx.userId, input.signalId);
    const existing = (await getTasks(ctx.userId)).find((task) => task.sourceSignalId === signal.id && task.status !== 'done');
    if (existing) {
      await patchTask(ctx.userId, existing.id, { dueAt: input.dueAt });
      return { summary: `Set the deadline on “${existing.title}”.`, output: { taskId: existing.id, createdTask: false, previousDueAt: existing.dueAt ?? null }, undoable: true };
    }
    const task = await createTask(ctx.userId, { title: input.label || signal.title, dueAt: input.dueAt, priority: signal.priority, source: 'manual', sourceSignalId: signal.id });
    return { summary: `Created “${task.title}” due ${input.dueAt.slice(0, 10)}.`, output: { taskId: task.id, createdTask: true }, undoable: true };
  },
  verify: async (_input, outcome, ctx) => ({ ok: !!(await getTask(ctx.userId, String(outcome.output.taskId))), detail: 'Task carries the deadline.' }),
  undo: async (_input, outcome, ctx) => {
    if (outcome.output.createdTask) await deleteTask(ctx.userId, String(outcome.output.taskId));
    else await patchTask(ctx.userId, String(outcome.output.taskId), { dueAt: (outcome.output.previousDueAt as string | null) ?? undefined });
    return { summary: 'Reverted the deadline.' };
  }
};

export const localTools: AnyTool[] = [searchSignals, listWaitingOn, listTasks, createTaskTool, updateTaskTool, createReminderTool, markNoise, snoozeSignal, markResolved, markWaitingOn, resolveCommitmentTool, snoozeCommitmentTool, ignoreSender, addPriorityPerson, extractDeadline];

export function registerLocalTools(): void {
  for (const tool of localTools) registerTool(tool);
}
