import { findConflicts, needsPreparation, type CalendarSpan } from '../calendar.js';
import { agentLimits } from './config.js';
import { proposeCalls, type PlannedCall } from './proposals.js';
import { startRun } from './runs.js';
import { getAgentSettings } from './settings.js';
import type { Signal } from '../types.js';

const WEEK_MS = 7 * 86_400_000;

/** Turns calendar conflicts and upcoming meetings into task proposals. Nothing on the calendar is changed. */
export async function ingestCalendar(userId: string, spans: CalendarSpan[], signals: Signal[], label: string, now = new Date()): Promise<void> {
  if (!agentLimits().enabled || (await getAgentSettings(userId)).paused) return;
  const signalFor = new Map(signals.map((signal) => [signal.sourceId, signal]));
  const upcoming = spans.filter((span) => new Date(span.start).getTime() >= now.getTime() && new Date(span.start).getTime() <= now.getTime() + WEEK_MS);
  const calls: PlannedCall[] = [];
  const dueBefore = (start: string, hoursBefore: number) => {
    const due = new Date(new Date(start).getTime() - hoursBefore * 3_600_000);
    return due.getTime() > now.getTime() ? due.toISOString() : undefined;
  };

  for (const [first, second] of findConflicts(upcoming)) {
    const signal = signalFor.get(first.id);
    if (!signal) continue;
    const day = first.start.slice(0, 10);
    calls.push({ tool: 'create_task', input: { title: `Resolve calendar conflict: ${first.title} overlaps ${second.title} on ${day}`.slice(0, 200), priority: 'now', dueAt: dueBefore(first.start, 2), sourceSignalId: signal.id }, reason: `“${first.title}” and “${second.title}” overlap on your calendar.`, sourceSignalId: signal.id });
  }
  for (const span of upcoming.filter((candidate) => needsPreparation(candidate, now))) {
    const signal = signalFor.get(span.id);
    if (!signal) continue;
    calls.push({ tool: 'create_task', input: { title: `Prepare for ${span.title}`.slice(0, 200), priority: 'soon', dueAt: dueBefore(span.start, 2), sourceSignalId: signal.id }, reason: `“${span.title}” starts within 48 hours${span.attendees ? ` with ${span.attendees} other attendee${span.attendees === 1 ? '' : 's'}` : ''}.`, sourceSignalId: signal.id });
  }
  if (!calls.length) return;
  const run = await startRun(userId, { objective: `Check ${label} for conflicts and preparation`, trigger: { type: 'sync', label }, plan: ['Find overlapping events in the next 7 days.', 'Find meetings in the next 48 hours that may need preparation.', 'Propose tasks for approval; your calendar is not changed.'] });
  await proposeCalls(userId, run, calls);
}
