import express from 'express';
import { z } from 'zod';
import { agentLimits } from '../agent/config.js';
import { askOrbit } from '../agent/ask.js';
import { commitments as commitmentStore, createCommitment, dismissCommitment, getCommitment, listCommitments, reopenCommitment, resolveCommitment, snoozeCommitment } from '../agent/commitments.js';
import { proposeFollowUp } from '../agent/followups.js';
import { createMemory, deleteMemory, exportMemories, listMemories, MEMORY_TYPES, updateMemory } from '../agent/memory.js';
import { approveProposal, giveFeedback, rejectProposal, retryProposal, undoExecution } from '../agent/proposals.js';
import { createReminder, dismissReminder, listReminders } from '../agent/reminders.js';
import { cancelRun, getRunDetail, listRuns } from '../agent/runs.js';
import { getAgentSettings, saveAgentSettings } from '../agent/settings.js';
import { SIGNAL_ACTIONS, proposeSignalAction } from '../agent/signalActions.js';
import { executionStore, proposalStore } from '../agent/stores.js';
import { getTool } from '../agent/tools/registry.js';
import { extractEmail } from '../agent/tools/util.js';
import { ActionableError } from '../diagnostics.js';
import { services } from '../agent/services.js';
import { notifications, notifier, ownerChannels } from '../notify.js';
import { getSignal } from '../store.js';
import { handle, ownerId } from './http.js';
import { setting } from '../installationConfig.js';
import { getBotToken } from '../telegram/api.js';
import { logActivity } from '../store.js';

export const agentRouter = express.Router();

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Use an ISO date').transform((value) => new Date(value).toISOString());

// ---- state & settings --------------------------------------------------------------------------------------

agentRouter.get('/state', handle(async (_req, res) => {
  const userId = ownerId(res);
  const [settings, gmail, calendar, pending, open] = await Promise.all([getAgentSettings(userId), services().gmail.capabilities(userId), services().calendar.capabilities(userId), proposalStore.count(userId, { status: 'pending' }), commitmentStore.count(userId, { status: 'open' })]);
  const limits = agentLimits();
  res.json({
    settings, pending, openCommitments: open,
    limits: { enabled: limits.enabled, maxSteps: limits.maxSteps, maxRunsPerDay: limits.maxRunsPerDay, approvalDefault: limits.approvalDefault, externalWritesEnabled: limits.externalWritesEnabled, emailSendingEnabled: limits.emailSendingEnabled, skillsEnabled: limits.skillsEnabled, mcpEnabled: limits.mcpEnabled, automationsEnabled: limits.automationsEnabled, memoryEnabled: limits.memoryEnabled, memoryRetentionDays: limits.memoryRetentionDays, runRetentionDays: limits.runRetentionDays },
    gmail: { connected: gmail.connected, canDraft: gmail.canDraft, accountEmail: gmail.accountEmail },
    calendar: { connected: calendar.connected, canWrite: calendar.canWrite },
    channels: { emailConfigured: !!setting('SMTP_URL'), telegramConfigured: !!getBotToken() }
  });
}));

const settingsPatch = z.object({
  paused: z.boolean().optional(),
  gmailAccess: z.enum(['read', 'drafts']).optional(),
  automationsKilled: z.boolean().optional(),
  timezone: z.string().max(80).optional(),
  channels: z.object({ browser: z.boolean().optional(), email: z.boolean().optional(), telegram: z.object({ enabled: z.boolean().optional(), chatId: z.string().regex(/^-?\d{1,20}$/, 'Use the numeric chat ID').optional().or(z.literal('')) }).optional() }).optional()
});

agentRouter.patch('/settings', handle(async (req, res) => {
  const userId = ownerId(res);
  const patch = settingsPatch.parse(req.body);
  const before = await getAgentSettings(userId);
  const telegram = patch.channels?.telegram ? { ...patch.channels.telegram, chatId: patch.channels.telegram.chatId === '' ? undefined : patch.channels.telegram.chatId } : undefined;
  const saved = await saveAgentSettings(userId, { ...patch, channels: patch.channels ? { ...patch.channels, telegram: telegram as never } : undefined });
  if (patch.paused !== undefined && patch.paused !== before.paused) await logActivity(userId, { type: 'agent', status: 'info', title: patch.paused ? 'Agent paused' : 'Agent resumed', detail: patch.paused ? 'Schedules, automations and write actions are stopped. Your connected sources stay connected.' : 'Schedules and actions will run again.' }).catch(() => undefined);
  res.json(saved);
}));

agentRouter.post('/channels/test', handle(async (_req, res) => {
  const userId = ownerId(res);
  const results = await notifier.deliver(userId, { title: 'Orbit test notification', body: 'If you can read this, this channel works.', kind: 'info' }, await ownerChannels(userId));
  res.json({ results });
}));

// ---- approvals ---------------------------------------------------------------------------------------------

agentRouter.get('/approvals', handle(async (_req, res) => {
  const userId = ownerId(res);
  const [pending, blocked, failed, recent] = await Promise.all([
    proposalStore.list(userId, { where: { status: 'pending' }, order: 'asc' }),
    proposalStore.list(userId, { where: { status: 'blocked' }, limit: 20 }),
    proposalStore.list(userId, { where: { status: 'failed' }, limit: 20 }),
    proposalStore.list(userId, { where: { status: ['executed', 'rejected', 'canceled'] }, limit: 30 })
  ]);
  const executions = await executionStore.list(userId, { limit: 60 });
  const byProposal = new Map(executions.map((execution) => [execution.proposalId, execution]));
  const decorate = (proposal: (typeof pending)[number]) => ({ ...proposal, execution: byProposal.get(proposal.id) ? { summary: byProposal.get(proposal.id)!.summary, status: byProposal.get(proposal.id)!.status, undoable: byProposal.get(proposal.id)!.undoable && byProposal.get(proposal.id)!.status !== 'undone', verification: byProposal.get(proposal.id)!.verification } : undefined });
  res.json({ pending: pending.map(decorate), blocked: blocked.map(decorate), failed: failed.map(decorate), recent: recent.map(decorate) });
}));

const approveBody = z.object({ editedInput: z.unknown().optional(), alwaysAllow: z.boolean().optional(), note: z.string().max(300).optional() });

agentRouter.post('/proposals/:id/approve', handle(async (req, res) => {
  const body = approveBody.parse(req.body ?? {});
  res.json(await approveProposal(ownerId(res), String(req.params.id), body));
}));
agentRouter.post('/proposals/:id/reject', handle(async (req, res) => res.json(await rejectProposal(ownerId(res), String(req.params.id), z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {}).note))));
agentRouter.post('/proposals/:id/retry', handle(async (req, res) => res.json(await retryProposal(ownerId(res), String(req.params.id)))));
agentRouter.post('/proposals/:id/undo', handle(async (req, res) => res.json(await undoExecution(ownerId(res), String(req.params.id)))));

const feedbackBody = z.object({ kind: z.enum(['helpful', 'not_helpful', 'remember', 'never']), scope: z.enum(['sender', 'tool']).optional() });

/** Learning controls: every outcome becomes a visible, editable rule, never a hidden model change. */
agentRouter.post('/proposals/:id/feedback', handle(async (req, res) => {
  const userId = ownerId(res);
  const { kind, scope } = feedbackBody.parse(req.body);
  const proposal = await proposalStore.get(userId, String(req.params.id));
  if (!proposal) throw new ActionableError('That action no longer exists.', { action: 'Refresh Approvals.', code: 'not_found' });
  if (kind === 'helpful' || kind === 'not_helpful') return res.json({ proposal: await giveFeedback(userId, proposal.id, kind) });
  const tool = getTool(proposal.toolName);
  const signal = proposal.sourceSignalId ? await getSignal(userId, proposal.sourceSignalId) : null;
  const sender = (tool?.senderEmail ? await tool.senderEmail(proposal.input, { userId, services: services() }).catch(() => undefined) : undefined) ?? (typeof signal?.metadata?.fromAddress === 'string' ? signal.metadata.fromAddress : extractEmail(signal?.sender));
  if (kind === 'remember') {
    if (!sender) throw new ActionableError('There is no sender to remember for this action.', { action: 'Add a rule yourself in Memory.', code: 'nothing_to_remember' });
    const { memory } = await createMemory(userId, { type: 'important_person', statement: `Messages from ${sender} are high priority.`, params: { email: sender }, source: { kind: 'feedback', ref: proposal.id, label: proposal.preview.title } });
    return res.json({ memory });
  }
  if (!sender && scope !== 'tool') throw new ActionableError(`Orbit cannot tell who this concerns, so “never” would block every “${proposal.toolName}” action.`, { action: 'Confirm that you want to block the whole action type, or reject this one instead.', code: 'scope_required' });
  const { memory } = await createMemory(userId, { type: 'approved_automation', statement: `Never “${proposal.toolName}”${sender ? ` for ${sender}` : ' (any message)'}.`, params: { tool: proposal.toolName, effect: 'deny', ...(sender ? { senderEmail: sender } : {}) }, source: { kind: 'feedback', ref: proposal.id, label: proposal.preview.title } });
  res.json({ memory });
}));

// ---- runs --------------------------------------------------------------------------------------------------

agentRouter.get('/runs', handle(async (req, res) => {
  const userId = ownerId(res);
  const runs = await listRuns(userId, Math.min(100, Number(req.query.limit) || 40));
  const counts = await Promise.all(runs.map(async (run) => ({ id: run.id, proposals: await proposalStore.count(userId, { runId: run.id }) })));
  const byRun = new Map(counts.map((entry) => [entry.id, entry.proposals]));
  res.json({ runs: runs.map((run) => ({ ...run, proposalCount: byRun.get(run.id) ?? 0 })) });
}));
agentRouter.get('/runs/:id', handle(async (req, res) => {
  const detail = await getRunDetail(ownerId(res), String(req.params.id));
  if (!detail) throw new ActionableError('That run no longer exists.', { action: 'Refresh Runs.', code: 'not_found' });
  res.json(detail);
}));
agentRouter.post('/runs/:id/cancel', handle(async (req, res) => {
  const run = await cancelRun(ownerId(res), String(req.params.id));
  if (!run) throw new ActionableError('That run no longer exists.', { action: 'Refresh Runs.', code: 'not_found' });
  res.json(run);
}));

// ---- actions on messages -----------------------------------------------------------------------------------

const signalActionBody = z.object({ action: z.enum(SIGNAL_ACTIONS), params: z.object({ action: z.string().max(240).optional(), dueAt: isoDate.optional(), until: isoDate.optional(), remindAt: isoDate.optional(), title: z.string().max(200).optional() }).default({}) });

agentRouter.post('/signals/:id/actions', handle(async (req, res) => {
  const { action, params } = signalActionBody.parse(req.body);
  const result = await proposeSignalAction(ownerId(res), String(req.params.id), action, params);
  res.status(201).json({ run: result.run, proposals: result.proposals, duplicates: result.duplicates.length, rejected: result.rejected });
}));

// ---- commitments -------------------------------------------------------------------------------------------

agentRouter.get('/commitments', handle(async (req, res) => {
  const status = String(req.query.status || 'open,snoozed').split(',').filter((value): value is 'open' | 'snoozed' | 'resolved' | 'dismissed' => ['open', 'snoozed', 'resolved', 'dismissed'].includes(value));
  res.json({ commitments: await listCommitments(ownerId(res), { status }) });
}));

const commitmentBody = z.object({ direction: z.enum(['i_owe', 'they_owe']), otherPerson: z.string().trim().min(1).max(120), otherEmail: z.string().max(200).optional(), action: z.string().trim().min(1).max(240), expectedAt: isoDate.optional() });
agentRouter.post('/commitments', handle(async (req, res) => {
  const body = commitmentBody.parse(req.body);
  const { commitment } = await createCommitment(ownerId(res), { ...body, otherEmail: extractEmail(body.otherEmail) });
  await createReminder(ownerId(res), { title: body.direction === 'they_owe' ? `Follow up with ${body.otherPerson}: ${body.action}` : `You owe ${body.otherPerson}: ${body.action}`, remindAt: commitment.followUpAt ?? commitment.expectedAt!, commitmentId: commitment.id }, `commit:${commitment.id}`);
  res.status(201).json(commitment);
}));

const commitmentPatch = z.object({ status: z.enum(['resolve', 'dismiss', 'reopen', 'snooze']).optional(), until: isoDate.optional(), expectedAt: isoDate.optional(), action: z.string().trim().min(1).max(240).optional() });
agentRouter.patch('/commitments/:id', handle(async (req, res) => {
  const userId = ownerId(res);
  const id = String(req.params.id);
  const body = commitmentPatch.parse(req.body);
  if (!(await getCommitment(userId, id))) throw new ActionableError('That commitment no longer exists.', { action: 'Refresh Waiting On.', code: 'not_found' });
  if (body.status === 'resolve') await resolveCommitment(userId, id);
  else if (body.status === 'dismiss') await dismissCommitment(userId, id);
  else if (body.status === 'reopen') await reopenCommitment(userId, id);
  else if (body.status === 'snooze') {
    if (!body.until) throw new ActionableError('Choose when to bring this back.', { action: 'Pick a date.' });
    await snoozeCommitment(userId, id, body.until);
  }
  if (body.expectedAt || body.action) await commitmentStore.update(userId, id, { ...(body.expectedAt ? { expectedAt: body.expectedAt, followUpAt: body.expectedAt } : {}), ...(body.action ? { action: body.action } : {}), updatedAt: new Date().toISOString() });
  res.json(await getCommitment(userId, id));
}));

agentRouter.post('/commitments/:id/follow-up', handle(async (req, res) => {
  const result = await proposeFollowUp(ownerId(res), String(req.params.id));
  res.status(201).json({ run: result.run, proposals: result.proposals, duplicates: result.duplicates.length });
}));

// ---- memory ------------------------------------------------------------------------------------------------

agentRouter.get('/memories', handle(async (_req, res) => res.json({ memories: await listMemories(ownerId(res)), enabled: agentLimits().memoryEnabled, types: MEMORY_TYPES })));
agentRouter.get('/memories/export', handle(async (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="orbit-memory.json"');
  res.json({ exportedAt: new Date().toISOString(), memories: await exportMemories(ownerId(res)) });
}));
const memoryBody = z.object({ type: z.enum(MEMORY_TYPES as [string, ...string[]]), statement: z.string().trim().min(1).max(300), params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}), localOnly: z.boolean().optional() });
agentRouter.post('/memories', handle(async (req, res) => {
  const body = memoryBody.parse(req.body);
  const { memory, created } = await createMemory(ownerId(res), { type: body.type as never, statement: body.statement, params: body.params, localOnly: body.localOnly, source: { kind: 'owner' } });
  res.status(created ? 201 : 200).json(memory);
}));
agentRouter.patch('/memories/:id', handle(async (req, res) => {
  const body = z.object({ statement: z.string().trim().min(1).max(300).optional(), enabled: z.boolean().optional(), localOnly: z.boolean().optional() }).parse(req.body);
  const memory = await updateMemory(ownerId(res), String(req.params.id), body);
  if (!memory) throw new ActionableError('That memory no longer exists.', { action: 'Refresh Memory.', code: 'not_found' });
  res.json(memory);
}));
agentRouter.delete('/memories/:id', handle(async (req, res) => {
  if (!(await deleteMemory(ownerId(res), String(req.params.id)))) throw new ActionableError('That memory no longer exists.', { action: 'Refresh Memory.', code: 'not_found' });
  res.status(204).end();
}));

// ---- reminders & notifications ----------------------------------------------------------------------------

agentRouter.get('/reminders', handle(async (_req, res) => res.json({ reminders: await listReminders(ownerId(res), ['scheduled']) })));
agentRouter.post('/reminders/:id/dismiss', handle(async (req, res) => {
  await dismissReminder(ownerId(res), String(req.params.id));
  res.status(204).end();
}));

export const notificationsRouter = express.Router();
notificationsRouter.get('/', handle(async (_req, res) => {
  const items = await notifications.list(ownerId(res), { limit: 40 });
  res.json({ notifications: items, unread: items.filter((item) => !item.read).length });
}));
notificationsRouter.post('/read', handle(async (req, res) => {
  const userId = ownerId(res);
  const ids = z.object({ ids: z.array(z.string()).max(100).optional() }).parse(req.body ?? {}).ids;
  const targets = ids ?? (await notifications.list(userId, { where: { read: false }, limit: 100 })).map((item) => item.id);
  for (const id of targets) await notifications.update(userId, id, { read: true });
  res.status(204).end();
}));

// ---- Ask Orbit ---------------------------------------------------------------------------------------------

export const askRouter = express.Router();
askRouter.post('/', handle(async (req, res) => {
  const { question } = z.object({ question: z.string().trim().min(1).max(600) }).parse(req.body);
  const result = await askOrbit(ownerId(res), question);
  await logActivity(ownerId(res), { type: 'ai', status: 'success', title: 'Ask Orbit answered', detail: `Run ${result.run.status}. ${result.proposals.length} action${result.proposals.length === 1 ? '' : 's'} proposed. The question and answer were not added to the activity log.` }).catch(() => undefined);
  res.json({ answer: result.answer, runId: result.run.id, proposals: result.proposals, duplicates: result.duplicates, rejected: result.rejected });
}));
