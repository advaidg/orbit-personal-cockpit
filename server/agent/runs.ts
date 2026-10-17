import crypto from 'node:crypto';
import { ActionableError } from '../diagnostics.js';
import { logActivity } from '../store.js';
import { agentLimits } from './config.js';
import { approvalStore, executionStore, proposalStore, runStore, stepStore } from './stores.js';
import type { ActionProposal, AgentRun, AgentStep, RunStatus, RunTrigger, StepStatus } from './types.js';
import type { AiProvider } from '../types.js';
import { cancelJob } from '../jobs.js';

const TERMINAL: RunStatus[] = ['succeeded', 'failed', 'canceled'];
const DAY_MS = 86_400_000;

export interface StartRunInput {
  objective: string;
  trigger: { type: RunTrigger; ref?: string; label?: string };
  plan?: string[];
  provider?: AiProvider;
  dryRun?: boolean;
  automationId?: string;
}

/** Rolling 24-hour count so AGENT_MAX_RUNS_PER_DAY cannot be dodged by crossing midnight. */
export async function runsInLastDay(userId: string, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  return (await runStore.list(userId, { limit: 1000 })).filter((run) => run.createdAt >= cutoff).length;
}

export async function startRun(userId: string, input: StartRunInput, now = new Date()): Promise<AgentRun> {
  const limits = agentLimits();
  if (!limits.enabled) throw new ActionableError('The agent is disabled on this installation.', { action: 'Set AGENT_ENABLED=true to turn it on.', code: 'agent_disabled' });
  if ((await runsInLastDay(userId, now)) >= limits.maxRunsPerDay) {
    throw new ActionableError(`Orbit reached its limit of ${limits.maxRunsPerDay} agent runs in 24 hours.`, { action: 'Wait for the window to pass, or raise AGENT_MAX_RUNS_PER_DAY on this installation.', code: 'run_limit' });
  }
  const run: AgentRun = {
    id: crypto.randomUUID(), userId, createdAt: now.toISOString(), updatedAt: now.toISOString(), startedAt: now.toISOString(),
    trigger: input.trigger, objective: input.objective.slice(0, 300), plan: (input.plan ?? []).slice(0, 12).map((line) => line.slice(0, 200)),
    provider: input.provider ?? 'rules', status: 'planning', dryRun: input.dryRun ?? false, automationId: input.automationId
  };
  const { item } = await runStore.insert(run);
  if (item.plan.length) await addStep(userId, item.id, { kind: 'plan', title: 'Plan', detail: item.plan.map((line, index) => `${index + 1}. ${line}`).join('\n'), status: 'succeeded' });
  return item;
}

export async function addStep(userId: string, runId: string, step: Pick<AgentStep, 'kind' | 'title'> & Partial<Pick<AgentStep, 'status' | 'detail' | 'toolName' | 'proposalId'>>): Promise<AgentStep> {
  const index = (await stepStore.count(userId, { runId })) + 1;
  const now = new Date().toISOString();
  const record: AgentStep = { id: crypto.randomUUID(), userId, createdAt: now, updatedAt: now, runId, index, kind: step.kind, title: step.title.slice(0, 200), status: step.status ?? 'pending', detail: step.detail?.slice(0, 1000), toolName: step.toolName, proposalId: step.proposalId };
  return (await stepStore.insert(record)).item;
}

export async function setStepForProposal(userId: string, proposalId: string, status: StepStatus, detail?: string): Promise<void> {
  const [step] = await stepStore.list(userId, { where: { proposalId }, limit: 1 });
  if (step) await stepStore.update(userId, step.id, { status, detail: detail?.slice(0, 1000) ?? step.detail, updatedAt: new Date().toISOString() });
}

function summarize(proposals: ActionProposal[]): string {
  const count = (...statuses: ActionProposal['status'][]) => proposals.filter((proposal) => statuses.includes(proposal.status)).length;
  const parts = [
    [count('executed'), 'done'], [count('pending'), 'waiting for approval'], [count('approved', 'executing'), 'in progress'],
    [count('rejected'), 'rejected'], [count('failed'), 'failed'], [count('blocked'), 'blocked by policy'], [count('previewed'), 'previewed only'], [count('canceled'), 'canceled']
  ].filter(([n]) => (n as number) > 0).map(([n, label]) => `${n} ${label}`);
  return parts.length ? parts.join(' · ') : 'Nothing needed to change.';
}

/** Recomputes a run's status from its proposals. Safe to call after any proposal changes. */
export async function refreshRunStatus(userId: string, runId: string): Promise<AgentRun | null> {
  const run = await runStore.get(userId, runId);
  if (!run || run.status === 'canceled') return run;
  const proposals = await proposalStore.list(userId, { where: { runId } });
  const has = (...statuses: ActionProposal['status'][]) => proposals.some((proposal) => statuses.includes(proposal.status));
  let status: RunStatus;
  if (has('pending')) status = 'awaiting_approval';
  else if (has('approved', 'executing')) status = 'executing';
  else if (has('failed')) status = 'failed';
  else status = 'succeeded';
  const failed = proposals.find((proposal) => proposal.status === 'failed');
  const now = new Date().toISOString();
  const next: Partial<AgentRun> = {
    status, result: summarize(proposals), updatedAt: now,
    error: failed?.lastError, finishedAt: TERMINAL.includes(status) ? (run.finishedAt ?? now) : undefined
  };
  const updated = await runStore.update(userId, runId, next);
  if (updated && status !== run.status && TERMINAL.includes(status)) {
    await logActivity(userId, { type: 'agent', status: status === 'succeeded' ? 'success' : 'error', title: `Agent run ${status === 'succeeded' ? 'completed' : 'needs attention'}`, detail: `${run.objective} — ${next.result}`, action: failed?.lastError?.action }).catch(() => undefined);
  }
  return updated;
}

/** Marks a run as finished with a text answer (for read-only requests that create no proposals). */
export async function finishRun(userId: string, runId: string, answer?: string): Promise<AgentRun | null> {
  const run = await runStore.get(userId, runId);
  if (!run || run.status === 'canceled') return run;
  if (answer !== undefined) await runStore.update(userId, runId, { answer: answer.slice(0, 4000) });
  return refreshRunStatus(userId, runId);
}

export async function failRun(userId: string, runId: string, error: { code: string; message: string; action: string }): Promise<void> {
  const now = new Date().toISOString();
  await runStore.update(userId, runId, { status: 'failed', error, finishedAt: now, updatedAt: now });
}

/** Cancels a run: waiting proposals are canceled and queued executions are stopped. */
export async function cancelRun(userId: string, runId: string): Promise<AgentRun | null> {
  const run = await runStore.get(userId, runId);
  if (!run) return null;
  if (TERMINAL.includes(run.status)) return run;
  await runStore.update(userId, runId, { cancelRequested: true });
  const proposals = await proposalStore.list(userId, { where: { runId } });
  for (const proposal of proposals) {
    if (proposal.jobId) await cancelJob(userId, proposal.jobId).catch(() => undefined);
    const canceled = await proposalStore.transition(userId, proposal.id, ['pending', 'approved'], { status: 'canceled', updatedAt: new Date().toISOString() });
    if (canceled) await setStepForProposal(userId, proposal.id, 'canceled', 'Canceled with the run.');
  }
  const now = new Date().toISOString();
  const updated = await runStore.update(userId, runId, { status: 'canceled', result: 'Canceled by you.', finishedAt: now, updatedAt: now });
  await logActivity(userId, { type: 'agent', status: 'info', title: 'Agent run canceled', detail: run.objective }).catch(() => undefined);
  return updated;
}

export async function getRunDetail(userId: string, runId: string) {
  const run = await runStore.get(userId, runId);
  if (!run) return null;
  const [steps, proposals, executions] = await Promise.all([
    stepStore.list(userId, { where: { runId }, order: 'asc' }),
    proposalStore.list(userId, { where: { runId }, order: 'asc' }),
    executionStore.list(userId, { where: { runId }, order: 'asc' })
  ]);
  return { run, steps, proposals, executions };
}

export async function listRuns(userId: string, limit = 50): Promise<AgentRun[]> {
  return runStore.list(userId, { limit });
}

/** Deletes finished runs (and their steps, proposals, approvals, executions) older than RUN_RETENTION_DAYS. */
export async function pruneRuns(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - agentLimits().runRetentionDays * DAY_MS).toISOString();
  const old = (await runStore.listAllOwners()).filter((run) => TERMINAL.includes(run.status) && run.createdAt < cutoff);
  for (const run of old) {
    await Promise.all([stepStore, proposalStore, approvalStore, executionStore].map((store) => store.deleteWhere(run.userId, { runId: run.id })));
    await runStore.delete(run.userId, run.id);
  }
  return old.length;
}
