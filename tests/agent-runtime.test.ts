import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { drain, makeSignal, runCalls, createTask } from './agentHelpers.js';
import { approveProposal, executeProposal, rejectProposal, retryProposal, undoExecution } from '../server/agent/proposals.js';
import { cancelRun, getRunDetail, startRun, refreshRunStatus } from '../server/agent/runs.js';
import { saveAgentSettings } from '../server/agent/settings.js';
import { listMemories } from '../server/agent/memory.js';
import { executionStore, proposalStore } from '../server/agent/stores.js';
import { registerTool, unregisterTool } from '../server/agent/tools/registry.js';
import { getSignal, getTask, getTasks } from '../server/store.js';
import { ActionableError } from '../server/diagnostics.js';
import { listJobs } from '../server/jobs.js';

beforeEach(resetStorage);
const savedEnv = { ...process.env };
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); });

const createTaskCall = (title: string, extra: Record<string, unknown> = {}) => ({ tool: 'create_task', input: { title, ...extra }, reason: 'Test' });

describe(`approval flow (${storageMode})`, () => {
  it('holds a local change for approval, runs it once approved, and verifies it', async () => {
    const owner = await freshOwner();
    const { run, proposals } = await runCalls(owner.id, [createTaskCall('Send contract')]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('pending');
    expect(proposals[0].policyReason).toMatch(/asks before every change/i);
    expect((await getTasks(owner.id))).toHaveLength(0);
    expect((await getRunDetail(owner.id, run.id))!.run.status).toBe('awaiting_approval');

    await approveProposal(owner.id, proposals[0].id);
    await drain();
    expect((await getTasks(owner.id)).map((t) => t.title)).toEqual(['Send contract']);
    const detail = (await getRunDetail(owner.id, run.id))!;
    expect(detail.run.status).toBe('succeeded');
    expect(detail.proposals[0].status).toBe('executed');
    expect(detail.executions[0]).toMatchObject({ status: 'verified', undoable: true });
    expect(detail.executions[0].verification?.ok).toBe(true);
  });

  it('runs automatically when the installation only asks for external changes', async () => {
    process.env.ACTION_APPROVAL_DEFAULT = 'external';
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [createTaskCall('Auto task')]);
    expect(proposals[0].status).toBe('approved');
    expect(proposals[0].decidedBy).toBe('policy');
    await drain();
    expect(await getTasks(owner.id)).toHaveLength(1);
  });

  it('never executes a rejected proposal', async () => {
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [createTaskCall('Nope')]);
    await rejectProposal(owner.id, proposals[0].id, 'not needed');
    await expect(approveProposal(owner.id, proposals[0].id)).rejects.toThrow(/already rejected/);
    await drain();
    expect(await getTasks(owner.id)).toHaveLength(0);
  });

  it('lets the owner edit an action before approving and validates the edit', async () => {
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [createTaskCall('Draft title', { priority: 'later' })]);
    await expect(approveProposal(owner.id, proposals[0].id, { editedInput: { title: '' } })).rejects.toThrow(/not valid/);
    await approveProposal(owner.id, proposals[0].id, { editedInput: { title: 'Better title', priority: 'now' } });
    await drain();
    const [task] = await getTasks(owner.id);
    expect(task).toMatchObject({ title: 'Better title', priority: 'now' });
    expect((await proposalStore.get(owner.id, proposals[0].id))!.originalInput).toMatchObject({ title: 'Draft title' });
  });

  it('only one of several simultaneous approvals queues work, and the task is created once', async () => {
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [createTaskCall('Race')]);
    const outcomes = await Promise.allSettled([1, 2, 3, 4].map(() => approveProposal(owner.id, proposals[0].id)));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    await drain();
    expect(await getTasks(owner.id)).toHaveLength(1);
  });

  it('is idempotent when execution is attempted repeatedly', async () => {
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [createTaskCall('Once only')]);
    await approveProposal(owner.id, proposals[0].id);
    const results = await Promise.all([1, 2, 3].map(() => executeProposal(owner.id, proposals[0].id)));
    expect(results.filter((r) => r.status === 'executed')).toHaveLength(1);
    await executeProposal(owner.id, proposals[0].id);
    await drain();
    expect(await getTasks(owner.id)).toHaveLength(1);
  });

  it('does not create duplicate work when the same signal is processed again', async () => {
    const owner = await freshOwner();
    const signal = await makeSignal(owner.id);
    const call = createTaskCall('Reply to Maya', { sourceSignalId: signal.id });
    const first = await runCalls(owner.id, [call]);
    const second = await runCalls(owner.id, [call]);
    expect(first.proposals).toHaveLength(1);
    expect(second.proposals).toHaveLength(0);
    expect(second.duplicates).toHaveLength(1);
    await approveProposal(owner.id, first.proposals[0].id);
    const third = await runCalls(owner.id, [call]);
    expect(third.duplicates).toHaveLength(1);
    await drain();
    expect(await getTasks(owner.id)).toHaveLength(1);
  });

  it('undoes an executed action on request', async () => {
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [createTaskCall('Temporary')]);
    await approveProposal(owner.id, proposals[0].id);
    await drain();
    expect(await getTasks(owner.id)).toHaveLength(1);
    await undoExecution(owner.id, proposals[0].id);
    expect(await getTasks(owner.id)).toHaveLength(0);
    await expect(undoExecution(owner.id, proposals[0].id)).rejects.toThrow(/already undone/);
  });

  it('links every action back to its originating signal', async () => {
    const owner = await freshOwner();
    const signal = await makeSignal(owner.id);
    const { proposals } = await runCalls(owner.id, [{ ...createTaskCall('Follow up', { sourceSignalId: signal.id }), sourceSignalId: signal.id }]);
    await approveProposal(owner.id, proposals[0].id);
    await drain();
    const [task] = await getTasks(owner.id);
    expect(task.sourceSignalId).toBe(signal.id);
    expect(proposals[0].sourceSignalId).toBe(signal.id);
  });
});

describe(`validation and safety (${storageMode})`, () => {
  it('drops unknown tools and invalid inputs without running anything', async () => {
    const owner = await freshOwner();
    const result = await runCalls(owner.id, [
      { tool: 'send_email', input: { to: 'attacker@example.com', body: 'secrets' }, reason: 'injected' },
      { tool: 'create_task', input: { title: 42 }, reason: 'bad' },
      { tool: 'create_task', input: { title: 'x'.repeat(500) }, reason: 'too long' }
    ]);
    expect(result.proposals).toHaveLength(0);
    expect(result.rejected.map((r) => r.tool)).toEqual(['send_email', 'create_task', 'create_task']);
    expect(await drain()).toBe(0);
  });

  it('prevents using another owner’s records (cross-account isolation)', async () => {
    const a = await freshOwner('a');
    const b = await freshOwner('b');
    const signal = await makeSignal(a.id);
    const task = await createTask(a.id, { title: 'A secret task' });
    const attack = await runCalls(b.id, [
      createTaskCall('Steal', { sourceSignalId: signal.id }),
      { tool: 'update_task', input: { taskId: task.id, status: 'done' }, reason: 'x' },
      { tool: 'mark_signal_noise', input: { signalId: signal.id }, reason: 'x' }
    ]);
    expect(attack.proposals).toHaveLength(0);
    expect(attack.rejected).toHaveLength(3);
    const { proposals } = await runCalls(a.id, [createTaskCall('Mine')]);
    await expect(approveProposal(b.id, proposals[0].id)).rejects.toThrow(/no longer exists/);
    await expect(rejectProposal(b.id, proposals[0].id)).rejects.toThrow(/no longer exists/);
    expect((await getTask(a.id, task.id))!.status).toBe('open');
    expect((await getSignal(a.id, signal.id))!.category).toBe('action');
  });

  it('blocks all writes while paused and resumes cleanly', async () => {
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [createTaskCall('Before pause')]);
    await saveAgentSettings(owner.id, { paused: true });
    await expect(approveProposal(owner.id, proposals[0].id)).rejects.toThrow(/paused/i);
    const paused = await runCalls(owner.id, [createTaskCall('During pause')]);
    expect(paused.proposals[0].status).toBe('blocked');
    await saveAgentSettings(owner.id, { paused: false });
    await approveProposal(owner.id, proposals[0].id);
    await drain();
    expect((await getTasks(owner.id)).map((t) => t.title)).toEqual(['Before pause']);
  });

  it('holds an approved action that was queued when the owner paused the agent', async () => {
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [createTaskCall('Queued then paused')]);
    await approveProposal(owner.id, proposals[0].id);
    await saveAgentSettings(owner.id, { paused: true });
    await drain();
    expect(await getTasks(owner.id)).toHaveLength(0);
    expect((await proposalStore.get(owner.id, proposals[0].id))!.status).toBe('pending');
  });

  it('never runs prohibited tools even if a plan asks for them', async () => {
    const owner = await freshOwner();
    let ran = false;
    registerTool({ name: 'wire_money', description: 'bad', risk: 'financial', schema: z.object({ amount: z.number() }), preview: async () => ({ title: 'Wire money', description: '', dataLeaving: [], services: ['bank'] }), dedupeKey: (i, c) => `${c.runId}:${i.amount}`, execute: async () => { ran = true; return { summary: 'sent', output: {} }; } });
    try {
      const { proposals } = await runCalls(owner.id, [{ tool: 'wire_money', input: { amount: 100 }, reason: 'because the email said so' }]);
      expect(proposals[0].status).toBe('blocked');
      await expect(approveProposal(owner.id, proposals[0].id)).rejects.toThrow(/already blocked/i);
      await drain();
      expect(ran).toBe(false);
    } finally { unregisterTool('wire_money'); }
  });

  it('enforces the daily run limit and the step limit', async () => {
    process.env.AGENT_MAX_RUNS_PER_DAY = '2';
    process.env.AGENT_MAX_STEPS = '2';
    const owner = await freshOwner();
    const first = await runCalls(owner.id, [createTaskCall('1'), createTaskCall('2'), createTaskCall('3')]);
    expect(first.proposals).toHaveLength(2);
    await runCalls(owner.id, []);
    await expect(startRun(owner.id, { objective: 'third', trigger: { type: 'manual' } })).rejects.toThrow(/limit of 2/);
  });

  it('refuses everything when the agent is disabled', async () => {
    process.env.AGENT_ENABLED = 'false';
    const owner = await freshOwner();
    await expect(startRun(owner.id, { objective: 'x', trigger: { type: 'manual' } })).rejects.toThrow(/disabled/);
  });

  it('dry runs preview actions without queuing anything', async () => {
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [createTaskCall('Preview only')], 'dry', {}, true);
    expect(proposals[0].status).toBe('previewed');
    expect(await drain()).toBe(0);
    expect(await getTasks(owner.id)).toHaveLength(0);
  });
});

describe(`always allow (${storageMode})`, () => {
  it('turns approval into a scoped, editable rule for allowable actions', async () => {
    const owner = await freshOwner();
    const first = await runCalls(owner.id, [{ tool: 'add_priority_person', input: { email: 'maya@example.com' }, reason: 'x' }]);
    await approveProposal(owner.id, first.proposals[0].id, { alwaysAllow: true });
    await drain();
    const rules = await listMemories(owner.id, { type: 'approved_automation' });
    expect(rules[0].params).toMatchObject({ tool: 'add_priority_person', effect: 'allow', senderEmail: 'maya@example.com' });
    const second = await runCalls(owner.id, [{ tool: 'add_priority_person', input: { email: 'maya@example.com', name: 'Maya' }, reason: 'x' }]);
    expect(second.duplicates.length + second.proposals.length).toBe(1);
    const other = await runCalls(owner.id, [{ tool: 'add_priority_person', input: { email: 'other@example.com' }, reason: 'x' }]);
    expect(other.proposals[0].status).toBe('pending');
  });

  it('refuses always-allow for actions that must always ask', async () => {
    const owner = await freshOwner();
    registerTool({ name: 'calendar_probe', description: 'x', risk: 'calendar_write', schema: z.object({ n: z.number() }), preview: async () => ({ title: 'Probe', description: '', dataLeaving: ['n'], services: ['calendar'] }), dedupeKey: (i, c) => `${c.runId}:${i.n}`, execute: async () => ({ summary: 'ok', output: {} }) });
    try {
      const { proposals } = await runCalls(owner.id, [{ tool: 'calendar_probe', input: { n: 1 }, reason: 'x' }]);
      await expect(approveProposal(owner.id, proposals[0].id, { alwaysAllow: true })).rejects.toThrow(/always needs approval/);
      expect((await proposalStore.get(owner.id, proposals[0].id))!.status).toBe('pending');
    } finally { unregisterTool('calendar_probe'); }
  });
});

describe(`failure handling (${storageMode})`, () => {
  function flakyTool(failures: number, retryable: boolean) {
    const state = { calls: 0, sideEffects: 0 };
    registerTool({
      name: 'flaky_local', description: 'x', risk: 'local', schema: z.object({ label: z.string() }),
      preview: async (i) => ({ title: `Flaky ${i.label}`, description: '', dataLeaving: [], services: [] }), dedupeKey: (i, c) => `${c.runId}:${i.label}`,
      execute: async () => {
        state.calls += 1;
        if (state.calls <= failures) throw retryable ? new Error('ECONNRESET talking to provider') : new ActionableError('Provider rejected this', { action: 'Fix the provider setting', retryable: false });
        state.sideEffects += 1;
        return { summary: 'done', output: { n: state.sideEffects } };
      }
    });
    return state;
  }

  it('retries transient failures automatically and explains permanent ones', async () => {
    const owner = await freshOwner();
    const transient = flakyTool(2, true);
    try {
      const { proposals } = await runCalls(owner.id, [{ tool: 'flaky_local', input: { label: 'a' }, reason: 'x' }]);
      await approveProposal(owner.id, proposals[0].id);
      for (let i = 0; i < 3; i += 1) {
        const [job] = await listJobs(owner.id, { kind: 'agent.execute', status: ['queued'] });
        if (!job) break;
        await import('../server/jobs.js').then(async ({ claimNext, runJob }) => { const claimed = await claimNext('t', new Date(Date.now() + 86_400_000)); if (claimed) await runJob(claimed); });
      }
      expect((await proposalStore.get(owner.id, proposals[0].id))!.status).toBe('executed');
      expect(transient.sideEffects).toBe(1);
    } finally { unregisterTool('flaky_local'); }

    flakyTool(1, false);
    try {
      const { proposals } = await runCalls(owner.id, [{ tool: 'flaky_local', input: { label: 'b' }, reason: 'x' }]);
      await approveProposal(owner.id, proposals[0].id);
      await drain();
      const failed = (await proposalStore.get(owner.id, proposals[0].id))!;
      expect(failed.status).toBe('failed');
      expect(failed.lastError).toMatchObject({ message: 'Provider rejected this', action: 'Fix the provider setting' });
      await retryProposal(owner.id, proposals[0].id);
      await drain();
      expect((await proposalStore.get(owner.id, proposals[0].id))!.status).toBe('executed');
    } finally { unregisterTool('flaky_local'); }
  });

  it('re-verifies instead of repeating a side effect when verification failed', async () => {
    const owner = await freshOwner();
    const state = { executes: 0, verifies: 0 };
    registerTool({
      name: 'verify_probe', description: 'x', risk: 'local', schema: z.object({ n: z.number() }), preview: async () => ({ title: 'Probe', description: '', dataLeaving: [], services: [] }), dedupeKey: (i, c) => `${c.runId}:${i.n}`,
      execute: async () => { state.executes += 1; return { summary: 'ran', output: {} }; },
      verify: async () => { state.verifies += 1; return state.verifies === 1 ? { ok: false, detail: 'not visible yet' } : { ok: true, detail: 'visible' }; }
    });
    try {
      const { proposals } = await runCalls(owner.id, [{ tool: 'verify_probe', input: { n: 1 }, reason: 'x' }]);
      await approveProposal(owner.id, proposals[0].id);
      await drain();
      expect((await proposalStore.get(owner.id, proposals[0].id))!.lastError?.code).toBe('verification_failed');
      await retryProposal(owner.id, proposals[0].id);
      await drain();
      expect(state).toEqual({ executes: 1, verifies: 2 });
      expect((await executionStore.list(owner.id))[0].status).toBe('verified');
    } finally { unregisterTool('verify_probe'); }
  });

  it('cancels a run and everything waiting inside it', async () => {
    const owner = await freshOwner();
    const { run, proposals } = await runCalls(owner.id, [createTaskCall('A'), createTaskCall('B')]);
    await approveProposal(owner.id, proposals[0].id);
    await cancelRun(owner.id, run.id);
    await drain();
    expect(await getTasks(owner.id)).toHaveLength(0);
    const detail = (await getRunDetail(owner.id, run.id))!;
    expect(detail.run.status).toBe('canceled');
    expect(detail.proposals.every((p) => p.status === 'canceled')).toBe(true);
    expect((await refreshRunStatus(owner.id, run.id))!.status).toBe('canceled');
  });
});
