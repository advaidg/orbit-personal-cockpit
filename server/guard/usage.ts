import crypto from 'node:crypto';
import { getAgentSettings } from '../agent/settings.js';
import { usageStore, getSettings } from './store.js';
import type { GuardUsage, UsageTotals } from './types.js';

const ZERO: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Cache reads are cheap and repeat every turn, so they count at one tenth when judging a budget. */
export const weighted = (totals: UsageTotals): number => totals.input + totals.output + totals.cacheWrite + Math.round(totals.cacheRead / 10);

export function sanitizeTotals(value: unknown): UsageTotals | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const read = (key: string) => (typeof item[key] === 'number' && Number.isFinite(item[key]) ? Math.max(0, Math.min(Math.floor(item[key] as number), 5_000_000_000)) : 0);
  const totals = { input: read('input'), output: read('output'), cacheRead: read('cacheRead'), cacheWrite: read('cacheWrite') };
  return weighted(totals) || totals.cacheRead ? totals : null;
}

export async function dayKey(userId: string, now = new Date()): Promise<string> {
  const { timezone } = await getAgentSettings(userId);
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const diff = (now: UsageTotals, before: UsageTotals): UsageTotals => ({ input: Math.max(0, now.input - before.input), output: Math.max(0, now.output - before.output), cacheRead: Math.max(0, now.cacheRead - before.cacheRead), cacheWrite: Math.max(0, now.cacheWrite - before.cacheWrite) });
const add = (a: UsageTotals, b: UsageTotals): UsageTotals => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

async function ensureDay(userId: string, agentId: string, day: string): Promise<GuardUsage> {
  const now = new Date().toISOString();
  const row: GuardUsage = { id: crypto.randomUUID(), userId, createdAt: now, updatedAt: now, agentId, day, totals: { ...ZERO }, sessions: {}, budgetNotified: false };
  return (await usageStore.insert(row, `${agentId}:${day}`)).item;
}

/**
 * Adds a session's usage to today's total. The agent reports each session's running total, and only the part
 * since the last report is added, so a repeated or out-of-order report can never double-count.
 */
export async function recordUsage(userId: string, agentId: string, sessionId: string, totals: UsageTotals, now = new Date()): Promise<GuardUsage> {
  const day = await dayKey(userId, now);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await ensureDay(userId, agentId, day);
    const before = current.sessions[sessionId] ?? ZERO;
    const delta = diff(totals, before);
    const sessions = { ...current.sessions };
    // Keep the largest total seen per session; keep the map small.
    sessions[sessionId] = { input: Math.max(before.input, totals.input), output: Math.max(before.output, totals.output), cacheRead: Math.max(before.cacheRead, totals.cacheRead), cacheWrite: Math.max(before.cacheWrite, totals.cacheWrite) };
    const keys = Object.keys(sessions);
    if (keys.length > 50) for (const key of keys.slice(0, keys.length - 50)) delete sessions[key];
    const saved = await usageStore.updateIf(userId, current.id, { updatedAt: current.updatedAt }, { totals: add(current.totals, delta), sessions, updatedAt: new Date().toISOString() });
    if (saved) return saved;
  }
  return ensureDay(userId, agentId, day);
}

export async function usageToday(userId: string, agentId: string, now = new Date()): Promise<GuardUsage> {
  return ensureDay(userId, agentId, await dayKey(userId, now));
}

export async function costOf(userId: string, totals: UsageTotals): Promise<number | null> {
  const rates = (await getSettings(userId)).usdPerMillion;
  if (!rates) return null;
  return (totals.input * rates.input + totals.output * rates.output + totals.cacheRead * rates.cacheRead + totals.cacheWrite * rates.cacheWrite) / 1_000_000;
}

export async function markBudgetNotified(userId: string, id: string): Promise<boolean> {
  return !!(await usageStore.updateIf(userId, id, { budgetNotified: false }, { budgetNotified: true }));
}
