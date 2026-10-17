import { registerJobHandler } from '../jobs.js';
import { executeProposal } from './proposals.js';

/** Durable handlers for the agent runtime. Registered once at startup (and in tests). */
export function registerAgentJobs(): void {
  registerJobHandler('agent.execute', async ({ job, signal }) => {
    const proposalId = String(job.payload.proposalId ?? '');
    if (!job.userId || !proposalId) throw new Error('agent.execute job is missing its owner or proposal');
    const result = await executeProposal(job.userId, proposalId, job.attempts, job.maxAttempts, signal);
    return { ...result };
  });
}
