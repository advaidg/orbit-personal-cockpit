import type { Memory } from './types.js';
import type { Signal } from '../types.js';
import { extractEmail } from './tools/util.js';

/** Pure helpers that apply the owner's editable memories to incoming messages. */

function senderMatches(memory: Memory, fromAddress: string | undefined): boolean {
  const address = fromAddress?.toLowerCase();
  if (!address) return false;
  const email = typeof memory.params.senderEmail === 'string' ? memory.params.senderEmail.toLowerCase() : typeof memory.params.email === 'string' ? memory.params.email.toLowerCase() : '';
  const domain = typeof memory.params.domain === 'string' ? memory.params.domain.toLowerCase().replace(/^@/, '') : '';
  return (!!email && email === address) || (!!domain && address.endsWith(`@${domain}`));
}

export interface MessageIdentity {
  from: string;
}

export const fromAddressOf = (from: string): string | undefined => extractEmail(from);

/** Messages the owner asked Orbit to ignore. */
export function isIgnored(memories: Memory[], from: string): boolean {
  const address = fromAddressOf(from);
  return memories.some((memory) => memory.enabled && memory.type === 'inbox_rule' && memory.params.action === 'ignore' && senderMatches(memory, address));
}

/** Messages that must never be sent to an external AI provider. */
export function requiresLocalProcessing(memories: Memory[], from: string): boolean {
  const address = fromAddressOf(from);
  return memories.some((memory) => memory.enabled && memory.type === 'privacy_restriction' && memory.params.scope !== 'allow' && senderMatches(memory, address));
}

export function isImportantPerson(memories: Memory[], from: string): boolean {
  const address = fromAddressOf(from);
  return memories.some((memory) => memory.enabled && memory.type === 'important_person' && senderMatches(memory, address));
}

type TriageResult = Pick<Signal, 'category' | 'priority'>;

/** Applies important-person and category rules after triage. Never lowers a message's urgency. */
export function adjustTriage<T extends TriageResult>(memories: Memory[], from: string, result: T): T {
  const address = fromAddressOf(from);
  let next = { ...result };
  for (const memory of memories) {
    if (!memory.enabled || memory.type !== 'inbox_rule' || memory.params.action !== 'category' || !senderMatches(memory, address)) continue;
    const category = String(memory.params.category ?? '');
    if (['action', 'waiting', 'calendar', 'money', 'travel', 'people', 'noise'].includes(category)) next = { ...next, category: category as Signal['category'] };
  }
  if (isImportantPerson(memories, from)) next = { ...next, priority: 'now', category: next.category === 'noise' ? 'people' : next.category };
  return next;
}

/** Working-hours memory: true when `at` falls inside the owner's stated hours (or none are set). */
export function withinWorkingHours(memories: Memory[], localHour: number, localWeekday: number): boolean {
  const rule = memories.find((memory) => memory.enabled && memory.type === 'working_hours');
  if (!rule) return true;
  const start = Number(rule.params.startHour ?? 0);
  const end = Number(rule.params.endHour ?? 24);
  const days = Array.isArray(rule.params.days) ? (rule.params.days as string[]).map(Number) : [1, 2, 3, 4, 5];
  return days.includes(localWeekday) && localHour >= start && localHour < end;
}
