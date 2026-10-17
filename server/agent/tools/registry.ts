import type { z } from 'zod';
import type { ProposalPreview, ToolRisk } from '../types.js';
import type { ToolServices } from '../services.js';

export interface ToolContext {
  userId: string;
  runId: string;
  proposalId?: string;
  idempotencyKey: string;
  signal?: AbortSignal;
  services: ToolServices;
  now: Date;
  /** True when an earlier attempt started this action but never recorded an outcome (for example, a crash). */
  recovering?: boolean;
}

export interface ToolOutcome {
  summary: string;
  output: Record<string, unknown>;
  undoable?: boolean;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  risk: ToolRisk;
  /** Input-dependent risk, for example a notification that stays inside Orbit is local. */
  riskFor?: (input: z.infer<S>) => ToolRisk;
  schema: S;
  /** Ownership and precondition checks. Throw ActionableError to reject the call. */
  authorize?: (input: z.infer<S>, ctx: Pick<ToolContext, 'userId' | 'services'>) => Promise<void>;
  preview: (input: z.infer<S>, ctx: Pick<ToolContext, 'userId' | 'services'>) => Promise<ProposalPreview>;
  /** Natural key. The same key never produces a second proposal, so reprocessing cannot duplicate work. */
  dedupeKey: (input: z.infer<S>, ctx: { runId: string }) => string;
  /** The person the action concerns, so "always allow" rules can be limited to one sender. */
  senderEmail?: (input: z.infer<S>, ctx: Pick<ToolContext, 'userId' | 'services'>) => Promise<string | undefined>;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolOutcome>;
  verify?: (input: z.infer<S>, outcome: ToolOutcome, ctx: ToolContext) => Promise<{ ok: boolean; detail: string }>;
  undo?: (input: z.infer<S>, outcome: ToolOutcome, ctx: ToolContext) => Promise<{ summary: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any>;

const registry = new Map<string, AnyTool>();

export function registerTool(tool: AnyTool): void {
  registry.set(tool.name, tool);
}

export function unregisterTool(name: string): void {
  registry.delete(name);
}

export const getTool = (name: string): AnyTool | undefined => registry.get(name);
export const listTools = (): AnyTool[] => [...registry.values()];

/** Static risk of a validated call. */
export function effectiveRisk(tool: AnyTool, input: unknown): ToolRisk {
  return tool.riskFor ? tool.riskFor(input) : tool.risk;
}
