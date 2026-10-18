import { getAgentSettings } from '../agent/settings.js';
import { services } from '../agent/services.js';
import { ownerChannels } from '../notify.js';
import { logSafe } from '../diagnostics.js';
import { dayKey, costOf, usageToday, weighted } from './usage.js';
import { agents, events, listAgents, getSettings, requests, saveSettings, usageStore } from './store.js';
import { agentLimits } from '../agent/config.js';
import { partsInZone } from '../agent/time.js';
import type { GuardEvent } from './types.js';

export interface GuardDay {
  total: number;
  allowed: number;
  asked: number;
  approved: number;
  denied: number;
  deferred: number;
  blocked: number;
  waitedSeconds: number;
  topAsked: Array<{ summary: string; count: number }>;
}

/** Counts what the agents did on one day. `since` is the start of that day. */
export function tally(list: GuardEvent[]): GuardDay {
  const asked = list.filter((event) => event.decidedBy === 'owner' || event.requestId);
  const askedTop = new Map<string, number>();
  for (const event of asked) askedTop.set(event.summary, (askedTop.get(event.summary) ?? 0) + 1);
  return {
    total: list.length,
    allowed: list.filter((event) => event.verdict === 'allow' && !event.requestId).length,
    asked: asked.length,
    approved: asked.filter((event) => event.verdict === 'allow').length,
    denied: list.filter((event) => event.verdict === 'deny' && event.decidedBy !== 'budget').length,
    deferred: list.filter((event) => event.verdict === 'defer').length,
    blocked: list.filter((event) => event.decidedBy === 'budget').length,
    waitedSeconds: Math.round(asked.reduce((sum, event) => sum + event.waitedMs, 0) / 1000),
    topAsked: [...askedTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([summary, count]) => ({ summary, count }))
  };
}

export async function eventsForDay(userId: string, day: string, timeZone: string): Promise<GuardEvent[]> {
  const recent = await events.list(userId, { limit: 2000 });
  return recent.filter((event) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(event.createdAt)) === day);
}

/** The evening summary: what the agents did, what needed you, what was blocked. Local to Orbit; nothing leaves but the message. */
export async function guardDigest(userId: string, now = new Date()): Promise<{ title: string; body: string } | null> {
  const [{ timezone }, day] = await Promise.all([getAgentSettings(userId), dayKey(userId, now)]);
  const list = await eventsForDay(userId, day, timezone);
  if (!list.length) return null;
  const stats = tally(list);
  const agents = await listAgents(userId);
  const usage = await Promise.all(agents.map(async (agent) => ({ agent, day: await usageToday(userId, agent.id, now) })));
  const tokens = usage.reduce((sum, item) => sum + weighted(item.day.totals), 0);
  const cost = (await Promise.all(usage.map((item) => costOf(userId, item.day.totals)))).reduce<number | null>((sum, value) => (value === null ? sum : (sum ?? 0) + value), null);
  const lines = [
    `${stats.total} tool calls: ${stats.allowed} passed silently, ${stats.asked} needed you (${stats.approved} approved), ${stats.denied} refused${stats.deferred ? `, ${stats.deferred} left to the agent’s own prompt` : ''}.`,
    stats.blocked ? `${stats.blocked} stopped by a daily budget.` : '',
    tokens ? `Usage: ${tokens.toLocaleString('en-US')} weighted tokens${cost !== null ? ` (about $${cost.toFixed(2)})` : ''}.` : '',
    stats.topAsked.length ? `Most asked: ${stats.topAsked.map((item) => `“${item.summary.slice(0, 60)}” ×${item.count}`).join('; ')}.` : '',
    stats.waitedSeconds ? `Agents waited ${Math.round(stats.waitedSeconds / 60) || 1} min in total for your answers.` : ''
  ].filter(Boolean);
  return { title: 'Your agents today', body: lines.join('\n') };
}

/** Sends each owner's digest once a day, after 6 pm in their timezone, if their agents did anything. */
export async function sendGuardDigests(owners: string[], now = new Date()): Promise<number> {
  let sent = 0;
  for (const userId of owners) {
    try {
      const [settings, agentSettings, day] = await Promise.all([getSettings(userId), getAgentSettings(userId), dayKey(userId, now)]);
      if (!settings.dailyDigest || settings.lastDigestDay === day || partsInZone(now, agentSettings.timezone).hour < 18) continue;
      const digest = await guardDigest(userId, now);
      await saveSettings(userId, { lastDigestDay: day });
      if (!digest) continue;
      await services().notifier.deliver(userId, { ...digest, kind: 'digest', link: '/#/guard' }, await ownerChannels(userId));
      sent += 1;
    } catch (error) {
      logSafe('guard digest', error);
    }
  }
  return sent;
}

/** Owners who have at least one live agent registered. */
export async function ownersWithAgents(): Promise<string[]> {
  return [...new Set((await agents.listAllOwners()).filter((agent) => !agent.revokedAt).map((agent) => agent.userId))];
}

/** Old events, answered requests and daily usage follow the same retention as agent runs. */
export async function pruneGuard(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - agentLimits().runRetentionDays * 86_400_000);
  await events.pruneBefore(cutoff);
  await requests.pruneBefore(cutoff);
  await usageStore.pruneBefore(cutoff);
}
