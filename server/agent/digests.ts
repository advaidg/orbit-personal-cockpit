import { getBrief, getSignals, getTasks } from '../store.js';
import { dueCommitments, listCommitments } from './commitments.js';
import { proposalStore } from './stores.js';
import type { Commitment } from './types.js';

export interface Digest {
  title: string;
  body: string;
}

const bullet = (lines: string[], empty: string) => (lines.length ? lines.map((line) => `• ${line}`).join('\n') : empty);
const day = (iso?: string) => (iso ? iso.slice(0, 10) : 'no date');
const describe = (commitment: Commitment) => (commitment.direction === 'they_owe' ? `${commitment.otherPerson}: ${commitment.action}` : `You → ${commitment.otherPerson}: ${commitment.action}`);

/** Everything below is assembled from stored records only. No AI provider is involved. */
export async function morningBrief(userId: string, now = new Date(), timeZone = 'UTC'): Promise<Digest> {
  const [brief, tasks, due, pending] = await Promise.all([getBrief(userId), getTasks(userId), dueCommitments(userId, now), proposalStore.count(userId, { status: 'pending' })]);
  const urgent = tasks.filter((task) => task.status === 'open').sort((a, b) => ({ now: 0, soon: 1, later: 2 })[a.priority] - ({ now: 0, soon: 1, later: 2 })[b.priority] || (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9')).slice(0, 5);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(now);
  return {
    title: `Good morning — your ${weekday} brief`,
    body: [brief?.headline ?? 'Your orbit is quiet.', '', 'Focus first:', bullet(urgent.map((task) => `${task.title}${task.dueAt ? ` (due ${day(task.dueAt)})` : ''}`), 'Nothing in your focus queue.'), '', 'Follow-ups due:', bullet(due.slice(0, 5).map(describe), 'No follow-ups due.'), '', pending ? `${pending} action${pending === 1 ? '' : 's'} waiting in Approvals.` : 'No approvals waiting.'].join('\n')
  };
}

export async function endOfDay(userId: string, now = new Date()): Promise<Digest> {
  const [tasks, signals, due] = await Promise.all([getTasks(userId), getSignals(userId), dueCommitments(userId, now)]);
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const openTasks = tasks.filter((task) => task.status === 'open' && task.priority !== 'later');
  const unread = signals.filter((signal) => signal.metadata?.direction !== 'outbound' && signal.category === 'action' && signal.priority === 'now' && (signal.metadata?.state as { status?: string } | undefined)?.status !== 'resolved' && signal.occurredAt >= startOfDay.toISOString());
  return {
    title: 'End of day — what is still open',
    body: ['Unfinished tasks:', bullet(openTasks.slice(0, 8).map((task) => task.title), 'All clear.'), '', 'Urgent messages from today still unresolved:', bullet(unread.slice(0, 5).map((signal) => signal.title), 'None.'), '', 'Follow-ups due:', bullet(due.slice(0, 5).map(describe), 'None.')].join('\n')
  };
}

/** The weekly "things that may be falling through" review. */
export async function weeklyWaitingOn(userId: string, now = new Date()): Promise<Digest> {
  const open = await listCommitments(userId, { status: ['open', 'snoozed'] });
  const overdue = open.filter((item) => (item.followUpAt ?? item.expectedAt ?? '9') <= now.toISOString());
  const theyOwe = open.filter((item) => item.direction === 'they_owe' && !overdue.includes(item));
  const iOwe = open.filter((item) => item.direction === 'i_owe' && !overdue.includes(item));
  return {
    title: 'Weekly review — things that may be falling through',
    body: ['Overdue:', bullet(overdue.map(describe), 'Nothing is overdue.'), '', 'Waiting on others:', bullet(theyOwe.slice(0, 8).map((item) => `${describe(item)} (expected ${day(item.expectedAt)})`), 'Nobody owes you anything right now.'), '', 'You owe:', bullet(iOwe.slice(0, 8).map((item) => `${describe(item)} (by ${day(item.expectedAt)})`), 'You are all caught up.')].join('\n')
  };
}
