import crypto from 'node:crypto';
import { ActionableError, diagnose, logSafe } from '../diagnostics.js';
import { enqueue, cancelJob } from '../jobs.js';
import { logActivity } from '../store.js';
import { providerIsExternal } from '../ai.js';
import type { AiProvider } from '../types.js';
import { agentLimits } from './config.js';
import { createMemory, approvalRules } from './memory.js';
import { ALWAYS_ALLOWABLE, decidePolicy, type AutomationApproval } from './policy.js';
import { getAgentSettings } from './settings.js';
import { approvalStore, executionStore, proposalStore, runStore } from './stores.js';
import { addStep, refreshRunStatus, setStepForProposal } from './runs.js';
import { services } from './services.js';
import { effectiveRisk, getTool, type ToolContext, type ToolOutcome } from './tools/registry.js';
import type { ActionProposal, AgentRun, ToolExecution } from './types.js';

export interface PlannedCall {
  tool: string;
  input: unknown;
  reason: string;
  sourceSignalId?: string;
  generatedBy?: AiProvider;
}

export interface ProposeOptions {
  automationApproval?: AutomationApproval;
}

export interface ProposeResult {
  proposals: ActionProposal[];
  duplicates: ActionProposal[];
  rejected: Array<{ tool: string; error: string }>;
  /** Outputs of read-only tools, which run inline and never need approval. */
  reads: Array<{ tool: string; summary: string; output: Record<string, unknown> }>;
}

const now = () => new Date().toISOString();

function toolContext(userId: string, run: Pick<AgentRun, 'id'>, key: string, proposalId?: string, signal?: AbortSignal): ToolContext {
  return { userId, runId: run.id, proposalId, idempotencyKey: key, signal, services: services(), now: new Date() };
}

function formatZod(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.slice(0, 3).map((issue) => `${issue.path.map(String).join('.') || 'input'}: ${issue.message}`).join('; ');
}

/**
 * Validates every planned call, applies policy, and records proposals. Nothing here touches an outside
 * service: automatic calls are queued for the durable worker, the rest wait for the owner.
 */
export async function proposeCalls(userId: string, run: AgentRun, calls: PlannedCall[], options: ProposeOptions = {}): Promise<ProposeResult> {
  const limits = agentLimits();
  const result: ProposeResult = { proposals: [], duplicates: [], rejected: [], reads: [] };
  const [settings, rules] = await Promise.all([getAgentSettings(userId), approvalRules(userId)]);
  const accepted = calls.slice(0, limits.maxSteps);
  if (calls.length > accepted.length) await addStep(userId, run.id, { kind: 'note', title: `Plan trimmed to ${limits.maxSteps} steps`, detail: `${calls.length - accepted.length} proposed actions were dropped (AGENT_MAX_STEPS).`, status: 'skipped' });

  for (const call of accepted) {
    const tool = getTool(call.tool);
    if (!tool) {
      result.rejected.push({ tool: call.tool, error: 'Unknown tool' });
      await addStep(userId, run.id, { kind: 'tool', title: `Rejected unknown tool “${call.tool.slice(0, 60)}”`, status: 'failed', detail: 'The plan asked for a tool Orbit does not have. It was not run.' });
      continue;
    }
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      const message = formatZod(parsed.error);
      result.rejected.push({ tool: call.tool, error: message });
      await addStep(userId, run.id, { kind: 'tool', title: `Rejected invalid ${tool.name} call`, status: 'failed', toolName: tool.name, detail: message });
      continue;
    }
    const input = parsed.data as Record<string, unknown>;
    const base = { userId, services: services() };
    try {
      await tool.authorize?.(input, base);
    } catch (error) {
      const message = diagnose(error).message;
      result.rejected.push({ tool: call.tool, error: message });
      await addStep(userId, run.id, { kind: 'tool', title: `Rejected ${tool.name}`, status: 'failed', toolName: tool.name, detail: message });
      continue;
    }

    const risk = effectiveRisk(tool, input);
    if (risk === 'read') {
      const ctx = toolContext(userId, run, `read:${run.id}:${tool.name}:${crypto.randomUUID()}`);
      const outcome = await tool.execute(input, ctx);
      result.reads.push({ tool: tool.name, summary: outcome.summary, output: outcome.output });
      await addStep(userId, run.id, { kind: 'tool', title: outcome.summary, status: 'succeeded', toolName: tool.name });
      continue;
    }

    const preview = await tool.preview(input, base);
    const sender = await tool.senderEmail?.(input, base);
    if (call.generatedBy && providerIsExternal(call.generatedBy)) preview.dataLeaving = [...preview.dataLeaving, `A short summary of the related message was sent to ${call.generatedBy} to write this suggestion.`];
    const decision = decidePolicy({ tool: tool.name, risk, limits, paused: settings.paused, draftsEnabled: settings.gmailAccess === 'drafts', rules, senderEmail: sender, automationApproval: options.automationApproval });
    const status: ActionProposal['status'] = decision.mode === 'prohibited' ? 'blocked' : run.dryRun ? 'previewed' : decision.mode === 'automatic' ? 'approved' : 'pending';
    const id = crypto.randomUUID();
    const proposal: ActionProposal = {
      id, userId, createdAt: now(), updatedAt: now(), runId: run.id, toolName: tool.name, risk, input, preview, reason: call.reason.slice(0, 400), status,
      decidedBy: status === 'approved' ? 'policy' : undefined, policyReason: decision.reason, alwaysAllowable: decision.alwaysAllowable && ALWAYS_ALLOWABLE.has(risk),
      sourceSignalId: call.sourceSignalId, idempotencyKey: `${tool.name}:${tool.dedupeKey(input, { runId: run.id })}`.slice(0, 300),
      blockedReason: decision.mode === 'prohibited' ? decision.reason : undefined, generatedBy: call.generatedBy
    };
    const inserted = await proposalStore.insert(proposal, proposal.idempotencyKey);
    if (!inserted.created) {
      result.duplicates.push(inserted.item);
      await addStep(userId, run.id, { kind: 'tool', title: `Skipped duplicate: ${preview.title}`, status: 'skipped', toolName: tool.name, detail: 'Orbit already proposed this exact action, so it was not queued again.' });
      continue;
    }
    result.proposals.push(inserted.item);
    const stepStatus = status === 'blocked' ? 'blocked' : status === 'pending' ? 'pending' : status === 'previewed' ? 'skipped' : 'pending';
    await addStep(userId, run.id, { kind: 'tool', title: preview.title, status: stepStatus, toolName: tool.name, proposalId: id, detail: status === 'blocked' ? decision.reason : status === 'previewed' ? 'Dry run: nothing was changed.' : decision.reason });
    if (status === 'approved') {
      await approvalStore.insert({ id: crypto.randomUUID(), userId, createdAt: now(), proposalId: id, runId: run.id, decision: 'approved', alwaysAllow: false, decidedBy: 'policy', note: decision.reason });
      await queueExecution(inserted.item);
    }
  }
  await refreshRunStatus(userId, run.id);
  return result;
}

async function queueExecution(proposal: ActionProposal, attempt = 1): Promise<void> {
  const { job } = await enqueue({ kind: 'agent.execute', userId: proposal.userId, payload: { proposalId: proposal.id }, idempotencyKey: `execute:${proposal.id}:${attempt}`, maxAttempts: 4 });
  await proposalStore.update(proposal.userId, proposal.id, { jobId: job.id });
}

export interface ApproveOptions {
  editedInput?: unknown;
  alwaysAllow?: boolean;
  note?: string;
}

/** Owner approval. Atomic: two simultaneous approvals cannot both queue an execution. */
export async function approveProposal(userId: string, proposalId: string, options: ApproveOptions = {}): Promise<ActionProposal> {
  const proposal = await proposalStore.get(userId, proposalId);
  if (!proposal) throw new ActionableError('That proposal no longer exists.', { action: 'Refresh Approvals.', code: 'not_found' });
  if (proposal.status !== 'pending') throw new ActionableError(`This proposal is already ${proposal.status}.`, { action: 'Refresh Approvals to see its current state.', code: 'not_pending' });
  const tool = getTool(proposal.toolName);
  if (!tool) throw new ActionableError('Orbit no longer has the tool this proposal needs.', { action: 'Reject it.', code: 'tool_missing' });
  const [settings, rules] = await Promise.all([getAgentSettings(userId), approvalRules(userId)]);
  const gate = decidePolicy({ tool: tool.name, risk: proposal.risk, limits: agentLimits(), paused: settings.paused, draftsEnabled: settings.gmailAccess === 'drafts', rules });
  if (gate.mode === 'prohibited') throw new ActionableError(gate.reason, { action: 'Change the setting that blocks it, then approve again.', code: 'policy_blocked' });

  let input = proposal.input;
  let preview = proposal.preview;
  if (options.editedInput !== undefined) {
    const parsed = tool.schema.safeParse(options.editedInput);
    if (!parsed.success) throw new ActionableError(`Your edit is not valid: ${formatZod(parsed.error)}`, { action: 'Fix the highlighted field and try again.', code: 'invalid_edit' });
    input = parsed.data as Record<string, unknown>;
    await tool.authorize?.(input, { userId, services: services() });
    preview = { ...(await tool.preview(input, { userId, services: services() })), dataLeaving: proposal.preview.dataLeaving };
  }
  if (options.alwaysAllow && !proposal.alwaysAllowable) throw new ActionableError('This kind of action always needs approval; it cannot be set to “always allow”.', { action: 'Approve it once instead.', code: 'not_allowable' });

  const approved = await proposalStore.transition(userId, proposalId, ['pending'], { status: 'approved', decidedBy: 'owner', input, preview, originalInput: options.editedInput !== undefined ? proposal.input : undefined, updatedAt: now() });
  if (!approved) throw new ActionableError('Someone else already decided this proposal.', { action: 'Refresh Approvals.', code: 'not_pending' });
  await approvalStore.insert({ id: crypto.randomUUID(), userId, createdAt: now(), proposalId, runId: proposal.runId, decision: 'approved', editedInput: options.editedInput !== undefined ? input : undefined, alwaysAllow: !!options.alwaysAllow, decidedBy: 'owner', note: options.note });
  if (options.alwaysAllow) {
    const sender = await tool.senderEmail?.(input, { userId, services: services() });
    await createMemory(userId, { type: 'approved_automation', statement: `Automatically allow “${tool.name}”${sender ? ` for ${sender}` : ''}.`, params: { tool: tool.name, effect: 'allow', ...(sender ? { senderEmail: sender } : {}) }, source: { kind: 'owner', ref: proposalId, label: 'Always allow from Approval Center' } });
  }
  await setStepForProposal(userId, proposalId, 'pending', 'Approved. Waiting for the worker.');
  await queueExecution(approved);
  await logActivity(userId, { type: 'agent', status: 'info', title: 'Action approved', detail: preview.title }).catch(logSafe.bind(null, 'activity'));
  await refreshRunStatus(userId, proposal.runId);
  return (await proposalStore.get(userId, proposalId))!;
}

export async function rejectProposal(userId: string, proposalId: string, note?: string): Promise<ActionProposal> {
  const proposal = await proposalStore.get(userId, proposalId);
  if (!proposal) throw new ActionableError('That proposal no longer exists.', { action: 'Refresh Approvals.', code: 'not_found' });
  const rejected = await proposalStore.transition(userId, proposalId, ['pending', 'blocked'], { status: 'rejected', decidedBy: 'owner', updatedAt: now() });
  if (!rejected) throw new ActionableError(`This proposal is already ${proposal.status}.`, { action: 'Refresh Approvals.', code: 'not_pending' });
  await approvalStore.insert({ id: crypto.randomUUID(), userId, createdAt: now(), proposalId, runId: proposal.runId, decision: 'rejected', alwaysAllow: false, decidedBy: 'owner', note });
  await setStepForProposal(userId, proposalId, 'rejected', note ? `Rejected: ${note.slice(0, 200)}` : 'Rejected by you.');
  await refreshRunStatus(userId, proposal.runId);
  return rejected;
}

/** Re-queues a failed proposal. Orbit never repeats work that already succeeded (see executeProposal). */
export async function retryProposal(userId: string, proposalId: string): Promise<ActionProposal> {
  const proposal = await proposalStore.get(userId, proposalId);
  if (!proposal) throw new ActionableError('That proposal no longer exists.', { action: 'Refresh Runs.', code: 'not_found' });
  const retried = await proposalStore.transition(userId, proposalId, ['failed'], { status: 'approved', lastError: undefined, updatedAt: now() });
  if (!retried) throw new ActionableError('Only failed actions can be retried.', { action: 'Refresh Runs.', code: 'not_failed' });
  const attempt = (await executionStore.list(userId, { where: { proposalId } }))[0]?.attempt ?? 0;
  await queueExecution(retried, attempt + 1);
  await setStepForProposal(userId, proposalId, 'pending', 'Retry queued.');
  await refreshRunStatus(userId, proposal.runId);
  return retried;
}

export interface ExecuteResult {
  status: 'executed' | 'failed' | 'skipped' | 'retry' | 'blocked';
  detail?: string;
}

/**
 * Runs an approved proposal exactly once. Safe to call repeatedly (job retries, duplicate jobs, redeploys):
 * status is claimed atomically, a persisted execution record prevents repeating a completed side effect,
 * and a failed verification re-verifies instead of re-executing.
 */
export async function executeProposal(userId: string, proposalId: string, attempt = 1, maxAttempts = 4, signal?: AbortSignal): Promise<ExecuteResult> {
  const claimed = await proposalStore.transition(userId, proposalId, ['approved'], { status: 'executing', updatedAt: now() });
  if (!claimed) return { status: 'skipped', detail: 'Not in an approved state.' };
  const tool = getTool(claimed.toolName);
  const settings = await getAgentSettings(userId);
  const limits = agentLimits();

  const finish = async (status: ActionProposal['status'], patch: Partial<ActionProposal>, stepDetail: string, stepStatus: 'succeeded' | 'failed' | 'blocked' | 'pending') => {
    await proposalStore.update(userId, proposalId, { status, updatedAt: now(), ...patch });
    await setStepForProposal(userId, proposalId, stepStatus, stepDetail);
    await refreshRunStatus(userId, claimed.runId);
  };

  if (!tool) {
    await finish('failed', { lastError: { code: 'tool_missing', message: 'Orbit no longer has this tool.', action: 'Reject the proposal.' } }, 'Tool is unavailable.', 'failed');
    return { status: 'failed', detail: 'tool missing' };
  }
  if (settings.paused || !limits.enabled) {
    await finish('pending', { blockedReason: settings.paused ? 'The agent was paused before this ran.' : 'The agent is disabled.' }, 'Held because the agent is paused. Approve again after resuming.', 'pending');
    return { status: 'blocked', detail: 'paused' };
  }
  const gate = decidePolicy({ tool: tool.name, risk: claimed.risk, limits, paused: false, draftsEnabled: settings.gmailAccess === 'drafts', rules: [] });
  if (gate.mode === 'prohibited') {
    await finish('blocked', { blockedReason: gate.reason }, gate.reason, 'blocked');
    return { status: 'blocked', detail: gate.reason };
  }

  const key = `exec:${proposalId}`;
  const startedAt = now();
  const fresh: ToolExecution = { id: crypto.randomUUID(), userId, createdAt: startedAt, updatedAt: startedAt, proposalId, runId: claimed.runId, toolName: tool.name, input: claimed.input, status: 'started', attempt };
  const stored = await executionStore.insert(fresh, key);
  let execution = stored.item;
  if (!stored.created) execution = (await executionStore.update(userId, execution.id, { attempt, updatedAt: now(), error: undefined })) ?? execution;

  const ctx = { ...toolContext(userId, { id: claimed.runId }, key, proposalId, signal), recovering: !stored.created && !execution.output };
  let outcome: ToolOutcome;
  if (execution.output) {
    outcome = { summary: execution.summary ?? '', output: execution.output, undoable: execution.undoable };
  } else {
    try {
      outcome = await tool.execute(claimed.input, ctx);
    } catch (error) {
      const diagnosis = diagnose(error);
      logSafe(`tool ${tool.name}`, error);
      const final = !diagnosis.retryable || attempt >= maxAttempts;
      const failure = { code: diagnosis.code, message: diagnosis.message, action: diagnosis.action };
      await executionStore.update(userId, execution.id, { status: 'failed', error: failure, finishedAt: now(), updatedAt: now() });
      if (final) {
        await finish('failed', { lastError: failure }, `${diagnosis.message} ${diagnosis.action}`, 'failed');
        return { status: 'failed', detail: diagnosis.message };
      }
      await finish('approved', { lastError: failure }, `Attempt ${attempt} failed: ${diagnosis.message} Retrying automatically.`, 'pending');
      throw error;
    }
    execution = (await executionStore.update(userId, execution.id, { status: 'executed', output: outcome.output, summary: outcome.summary, undoable: outcome.undoable ?? false, updatedAt: now() })) ?? execution;
  }

  const verification = tool.verify ? await tool.verify(claimed.input, outcome, ctx).catch((error) => ({ ok: false, detail: diagnose(error).message })) : { ok: true, detail: 'No separate verification needed.' };
  if (!verification.ok) {
    const error = { code: 'verification_failed', message: 'The action ran, but Orbit could not confirm the result.', action: 'Check the destination, then Retry. Orbit will not repeat the action itself.' };
    await executionStore.update(userId, execution.id, { status: 'verification_failed', verification, error, finishedAt: now(), updatedAt: now() });
    await finish('failed', { lastError: error }, `${error.message} ${verification.detail}`, 'failed');
    return { status: 'failed', detail: verification.detail };
  }
  await executionStore.update(userId, execution.id, { status: 'verified', verification, error: undefined, finishedAt: now(), updatedAt: now() });
  await finish('executed', { lastError: undefined, blockedReason: undefined }, `${outcome.summary} ${verification.detail}`, 'succeeded');
  await logActivity(userId, { type: 'agent', status: 'success', title: outcome.summary, detail: claimed.preview.title }).catch(() => undefined);
  return { status: 'executed', detail: outcome.summary };
}

/** Owner-initiated reversal. Agents and automations have no path to this function. */
export async function undoExecution(userId: string, proposalId: string): Promise<{ summary: string }> {
  const [execution] = await executionStore.list(userId, { where: { proposalId }, limit: 1 });
  if (!execution || !execution.output) throw new ActionableError('There is nothing to undo for this action.', { action: 'Refresh Runs.', code: 'not_found' });
  if (execution.status === 'undone') throw new ActionableError('This action was already undone.', { action: 'Nothing else to do.', code: 'already_undone' });
  const tool = getTool(execution.toolName);
  if (!tool?.undo || !execution.undoable) throw new ActionableError('This action cannot be undone automatically.', { action: 'Reverse it directly in the destination service.', code: 'not_undoable' });
  const claimed = await executionStore.transition(userId, execution.id, ['verified', 'executed', 'verification_failed'], { status: 'undone', undoneAt: now(), updatedAt: now() });
  if (!claimed) throw new ActionableError('This action was already undone.', { action: 'Nothing else to do.', code: 'already_undone' });
  try {
    const result = await tool.undo(execution.input, { summary: execution.summary ?? '', output: execution.output }, toolContext(userId, { id: execution.runId }, `undo:${proposalId}`, proposalId));
    await logActivity(userId, { type: 'agent', status: 'info', title: 'Action undone', detail: result.summary }).catch(() => undefined);
    return result;
  } catch (error) {
    await executionStore.update(userId, execution.id, { status: 'verified', undoneAt: undefined, updatedAt: now() });
    throw error;
  }
}

export async function giveFeedback(userId: string, proposalId: string, feedback: 'helpful' | 'not_helpful'): Promise<ActionProposal | null> {
  return proposalStore.update(userId, proposalId, { feedback, updatedAt: now() });
}

export async function listPending(userId: string): Promise<ActionProposal[]> {
  return proposalStore.list(userId, { where: { status: 'pending' } });
}

/** Cancels the queued job behind a proposal. Used when its source disappears. */
export async function cancelProposalJob(userId: string, proposal: ActionProposal): Promise<void> {
  if (proposal.jobId) await cancelJob(userId, proposal.jobId);
}

export { runStore };
