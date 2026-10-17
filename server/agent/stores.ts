import { Collection } from '../collection.js';
import type { ActionProposal, AgentRun, AgentStep, Approval, ToolExecution } from './types.js';

export const runStore = new Collection<AgentRun>('agent_runs');
export const stepStore = new Collection<AgentStep>('agent_steps');
export const proposalStore = new Collection<ActionProposal>('action_proposals');
export const approvalStore = new Collection<Approval>('approvals');
export const executionStore = new Collection<ToolExecution>('tool_executions');
