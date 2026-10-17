import crypto from 'node:crypto';
import { Collection } from '../collection.js';
import { agentLimits } from './config.js';
import type { Memory, MemoryType } from './types.js';
import { ActionableError } from '../diagnostics.js';

const memories = new Collection<Memory>('memories');

export const MEMORY_TYPES: MemoryType[] = ['important_person', 'organization', 'working_hours', 'recurring_commitment', 'communication_preference', 'inbox_rule', 'privacy_restriction', 'approved_automation'];

export interface MemoryInput {
  type: MemoryType;
  statement: string;
  params?: Memory['params'];
  source?: Memory['source'];
  localOnly?: boolean;
  enabled?: boolean;
}

/** Stable key so the same rule created twice (for example from repeated feedback) is stored once. */
export function memoryKey(type: MemoryType, params: Memory['params']): string {
  const canonical = JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, typeof value === 'string' ? value.toLowerCase() : value]));
  return `${type}:${crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16)}`;
}

function ensureEnabled(): void {
  if (!agentLimits().memoryEnabled) throw new ActionableError('Memory is disabled on this installation.', { action: 'Set MEMORY_ENABLED=true to let Orbit remember preferences.', retryable: false, code: 'memory_disabled' });
}

export async function createMemory(userId: string, input: MemoryInput): Promise<{ memory: Memory; created: boolean }> {
  ensureEnabled();
  if (!MEMORY_TYPES.includes(input.type)) throw new ActionableError(`Unknown memory type: ${input.type}`);
  const statement = input.statement.trim().slice(0, 300);
  if (!statement) throw new ActionableError('A memory needs a statement the owner can read.', { action: 'Describe the rule in a sentence.' });
  const params = input.params ?? {};
  const now = new Date().toISOString();
  const memory: Memory = {
    id: crypto.randomUUID(), userId, createdAt: now, updatedAt: now, type: input.type, statement, params,
    source: input.source ?? { kind: 'owner' }, enabled: input.enabled ?? true, localOnly: input.localOnly ?? false
  };
  const result = await memories.insert(memory, memoryKey(input.type, params));
  return { memory: result.item, created: result.created };
}

export async function listMemories(userId: string, options: { type?: MemoryType; enabledOnly?: boolean } = {}): Promise<Memory[]> {
  if (!agentLimits().memoryEnabled) return [];
  const where: Record<string, string | boolean> = {};
  if (options.type) where.type = options.type;
  if (options.enabledOnly) where.enabled = true;
  return memories.list(userId, { where });
}

export async function updateMemory(userId: string, id: string, patch: Partial<Pick<Memory, 'statement' | 'enabled' | 'localOnly'>>): Promise<Memory | null> {
  const clean: Partial<Memory> = { updatedAt: new Date().toISOString() };
  if (patch.statement !== undefined) clean.statement = patch.statement.trim().slice(0, 300);
  if (patch.enabled !== undefined) clean.enabled = patch.enabled;
  if (patch.localOnly !== undefined) clean.localOnly = patch.localOnly;
  return memories.update(userId, id, clean);
}

export const deleteMemory = (userId: string, id: string) => memories.delete(userId, id);
export const getMemory = (userId: string, id: string) => memories.get(userId, id);

export async function approvalRules(userId: string): Promise<Memory[]> {
  return listMemories(userId, { type: 'approved_automation', enabledOnly: true });
}

/** Memories that may be placed in an external AI prompt. Local-only memories never leave the installation. */
export async function shareableMemories(userId: string): Promise<Memory[]> {
  return (await listMemories(userId, { enabledOnly: true })).filter((memory) => !memory.localOnly && memory.type !== 'privacy_restriction' && memory.type !== 'approved_automation');
}

/** Removes memories untouched for MEMORY_RETENTION_DAYS (all owners). */
export async function pruneMemories(): Promise<number> {
  const days = agentLimits().memoryRetentionDays;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const all = await memories.listAllOwners();
  let removed = 0;
  for (const memory of all) {
    if (memory.updatedAt < cutoff.toISOString()) {
      await memories.delete(memory.userId, memory.id);
      removed += 1;
    }
  }
  return removed;
}

export async function exportMemories(userId: string): Promise<Memory[]> {
  return memories.list(userId, { order: 'asc' });
}
