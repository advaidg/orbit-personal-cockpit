import crypto from 'node:crypto';
import { initAgent } from '../server/agent/index.js';
import { startRun } from '../server/agent/runs.js';
import { proposeCalls, type PlannedCall } from '../server/agent/proposals.js';
import { drainJobs } from '../server/jobs.js';
import { upsertSignal, createTask } from '../server/store.js';
import type { Signal } from '../server/types.js';

initAgent();

export async function makeSignal(userId: string, overrides: Partial<Signal> = {}): Promise<Signal> {
  const signal: Signal = {
    id: crypto.randomUUID(), userId, source: 'gmail', sourceId: crypto.randomUUID(), sender: 'Maya Chen <maya@example.com>', title: 'Launch copy approval',
    summary: 'Maya needs your sign-off on the launch copy.', occurredAt: new Date().toISOString(), category: 'action', priority: 'now', read: false,
    metadata: { account: 'Work Gmail', threadId: 'thread-1', fromAddress: 'maya@example.com', direction: 'inbound' }, ...overrides
  };
  await upsertSignal(signal);
  return signal;
}

export { createTask };

export async function runCalls(userId: string, calls: PlannedCall[], objective = 'Test objective', options: Parameters<typeof proposeCalls>[3] = {}, dryRun = false) {
  const run = await startRun(userId, { objective, trigger: { type: 'manual' }, dryRun });
  const result = await proposeCalls(userId, run, calls, options);
  return { run, ...result };
}

export const drain = () => drainJobs();
