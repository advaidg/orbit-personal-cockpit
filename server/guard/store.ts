import crypto from 'node:crypto';
import { Collection } from '../collection.js';
import type { GuardAgent, GuardEvent, GuardRequest, GuardRule, GuardSettings, GuardUsage } from './types.js';

export const agents = new Collection<GuardAgent>('guard_agents');
export const rulesStore = new Collection<GuardRule>('guard_rules');
export const requests = new Collection<GuardRequest>('guard_requests');
export const events = new Collection<GuardEvent>('guard_events');
export const usageStore = new Collection<GuardUsage>('guard_usage');
const configStore = new Collection<GuardSettings>('guard_config');

export const TOKEN_PREFIX = 'og_';
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function defaultSettings(userId: string): GuardSettings {
  const now = new Date().toISOString();
  return { id: `guard-settings:${userId}`, userId, createdAt: now, updatedAt: now, strictness: 'balanced', waitSeconds: 180, onTimeout: 'defer', dailyDigest: true };
}

export async function getSettings(userId: string): Promise<GuardSettings> {
  return (await configStore.get(userId, `guard-settings:${userId}`)) ?? defaultSettings(userId);
}

export type SettingsPatch = Partial<Pick<GuardSettings, 'strictness' | 'waitSeconds' | 'onTimeout' | 'usdPerMillion' | 'dailyDigest' | 'lastDigestDay'>>;
/** Fields where null means "clear it" (a missing key in a JSON merge would keep the old value). */

export async function saveSettings(userId: string, patch: SettingsPatch): Promise<GuardSettings> {
  const current = await getSettings(userId);
  const next: GuardSettings = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: new Date().toISOString() };
  const { created } = await configStore.insert(next, 'settings');
  if (created) return next;
  return (await configStore.update(userId, next.id, next)) ?? next;
}

// ---- agents -----------------------------------------------------------------------------------------------------

export interface CreatedAgent { agent: GuardAgent; token: string }

/** Registers an agent. The token is returned once; only its hash is stored. */
export async function createAgent(userId: string, input: { name: string; kind?: GuardAgent['kind']; dailyTokenBudget?: number | null }): Promise<CreatedAgent> {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  const now = new Date().toISOString();
  const agent: GuardAgent = {
    id: crypto.randomUUID(), userId, createdAt: now, updatedAt: now, name: input.name.slice(0, 60), kind: input.kind ?? 'claude-code',
    tokenHash: sha256(token), tokenHint: `…${token.slice(-4)}`, paused: false, dailyTokenBudget: input.dailyTokenBudget
  };
  await agents.insert(agent, `token:${agent.tokenHash}`);
  return { agent, token };
}

/** Finds the agent a bearer token belongs to. Unknown, malformed and revoked tokens all look the same. */
export async function agentForToken(token: string): Promise<GuardAgent | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 120) return null;
  const hash = sha256(token);
  const [match] = await agents.listAllOwners({ where: { tokenHash: hash } });
  if (!match || match.revokedAt) return null;
  const expected = Buffer.from(match.tokenHash, 'hex');
  const actual = Buffer.from(hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) ? match : null;
}

export async function listAgents(userId: string): Promise<GuardAgent[]> {
  return (await agents.list(userId)).filter((agent) => !agent.revokedAt);
}

export async function updateAgent(userId: string, id: string, patch: Partial<Pick<GuardAgent, 'name' | 'paused' | 'dailyTokenBudget' | 'lastSeenAt'>>): Promise<GuardAgent | null> {
  return agents.update(userId, id, { ...patch, updatedAt: new Date().toISOString() });
}

export async function revokeAgent(userId: string, id: string): Promise<boolean> {
  const current = await agents.get(userId, id);
  if (!current || current.revokedAt) return false;
  return !!(await agents.update(userId, id, { revokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
}

// ---- rules -----------------------------------------------------------------------------------------------------

export async function listRules(userId: string): Promise<GuardRule[]> {
  return (await rulesStore.list(userId, { order: 'asc' }));
}

export interface NewRule { tool: string; match: GuardRule['match']; value: string; valueHash?: string; project?: string; action: GuardRule['action']; note?: string }

export async function addRule(userId: string, input: NewRule): Promise<{ rule: GuardRule; created: boolean }> {
  const now = new Date().toISOString();
  const rule: GuardRule = { id: crypto.randomUUID(), userId, createdAt: now, updatedAt: now, tool: input.tool, match: input.match, value: input.value.slice(0, 500), valueHash: input.valueHash, project: input.project || undefined, action: input.action, note: input.note?.slice(0, 200), hits: 0 };
  const key = sha256(`${rule.tool}|${rule.match}|${rule.valueHash ?? rule.value}|${rule.project ?? ''}|${rule.action}`);
  const { item, created } = await rulesStore.insert(rule, `rule:${key}`);
  return { rule: item, created };
}

export const deleteRule = (userId: string, id: string) => rulesStore.delete(userId, id);
