import crypto from 'node:crypto';
import { google, calendar_v3 } from 'googleapis';
import { decrypt } from './crypto.js';
import { GoogleTokens, grantedScopes, oauthClient } from './gmail.js';
import { providerLimiter } from './providerLimits.js';
import type { SyncHooks } from './gmail.js';
import { deleteSignalsBySourceIds, getSignals, upsertSignal } from './store.js';
import type { Connection, Signal } from './types.js';

export const CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export const canReadCalendar = (tokens: GoogleTokens) => grantedScopes(tokens).some((scope) => scope === CALENDAR_READ_SCOPE || scope === CALENDAR_EVENTS_SCOPE);
export const canWriteCalendar = (tokens: GoogleTokens) => grantedScopes(tokens).includes(CALENDAR_EVENTS_SCOPE);

export function calendarClient(tokens: GoogleTokens) {
  const auth = oauthClient();
  auth.setCredentials(tokens);
  return google.calendar({ version: 'v3', auth });
}

export interface CalendarSpan {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees: number;
}

/** Pairs of timed events whose ranges overlap. All-day events never conflict. */
export function findConflicts(events: CalendarSpan[]): Array<[CalendarSpan, CalendarSpan]> {
  const timed = events.filter((event) => !event.allDay).sort((a, b) => a.start.localeCompare(b.start));
  const conflicts: Array<[CalendarSpan, CalendarSpan]> = [];
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length && timed[j].start < timed[i].end; j += 1) conflicts.push([timed[i], timed[j]]);
  }
  return conflicts;
}

const PREP_TITLE = /\b(review|interview|presentation|demo|pitch|1:1|one[- ]on[- ]one|board|planning|kickoff|workshop|deadline)\b/i;

/** Events in the next 48 hours that likely deserve preparation. */
export function needsPreparation(event: CalendarSpan, now: Date): boolean {
  const start = new Date(event.start).getTime();
  return !event.allDay && start > now.getTime() && start - now.getTime() <= 48 * 3_600_000 && (event.attendees >= 2 || PREP_TITLE.test(event.title));
}

export const stableCalendarSignalId = (userId: string, eventId: string) => crypto.createHash('sha1').update(`signal:${userId}:calendar:${eventId}`).digest('hex');

function toSpan(event: calendar_v3.Schema$Event): CalendarSpan | null {
  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;
  if (!event.id || !start || !end || event.status === 'cancelled') return null;
  return { id: event.id, title: event.summary || '(untitled event)', start: new Date(start).toISOString(), end: new Date(end).toISOString(), allDay: !event.start?.dateTime, attendees: (event.attendees ?? []).filter((person) => !person.self && !person.resource).length };
}

function priorityFor(start: string, now: Date): Signal['priority'] {
  const hours = (new Date(start).getTime() - now.getTime()) / 3_600_000;
  return hours <= 24 ? 'now' : hours <= 72 ? 'soon' : 'later';
}

const fmt = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC';

export interface CalendarSyncResult {
  fetched: number;
  spans: CalendarSpan[];
  signals: Signal[];
}

/** Reads the next two weeks of events into signals. Updates moved events and removes cancelled ones. */
export async function syncCalendarConnection(connection: Connection, hooks: SyncHooks = {}, now = new Date()): Promise<CalendarSyncResult | null> {
  if (!connection.encryptedTokens) return null;
  const tokens = decrypt<GoogleTokens>(connection.encryptedTokens);
  if (!canReadCalendar(tokens)) throw new Error('Calendar authorization is missing the calendar.readonly scope');
  await hooks.progress?.({ phase: 'fetching', message: `Reading ${connection.label}` });
  const client = calendarClient(tokens);
  const timeMin = new Date(now.getTime() - 86_400_000).toISOString();
  const timeMax = new Date(now.getTime() + 14 * 86_400_000).toISOString();
  const { data } = await providerLimiter.run('calendar', () => client.events.list({ calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 100 }));
  await hooks.throwIfCanceled?.();
  const spans = (data.items ?? []).map(toSpan).filter((span): span is CalendarSpan => !!span);
  const previous = new Map((await getSignals(connection.userId)).filter((signal) => signal.source === 'calendar').map((signal) => [signal.sourceId, signal]));
  const signals: Signal[] = [];
  for (const span of spans) {
    const before = previous.get(span.id);
    const moved = before && before.metadata?.startsAt && before.metadata.startsAt !== span.start;
    const when = span.allDay ? `${span.start.slice(0, 10)} (all day)` : `${fmt(span.start)} – ${span.end.slice(11, 16)}`;
    const signal: Signal = {
      id: stableCalendarSignalId(connection.userId, span.id), userId: connection.userId, source: 'calendar', sourceId: span.id, sender: 'Google Calendar', title: span.title,
      summary: moved ? `Moved from ${fmt(String(before!.metadata!.startsAt))} to ${when}.` : `${when}${span.attendees ? ` · ${span.attendees} attendee${span.attendees === 1 ? '' : 's'}` : ''}`,
      occurredAt: span.start, category: 'calendar', priority: moved ? 'now' : priorityFor(span.start, now), read: before?.read ?? false,
      metadata: { account: connection.label, connectionId: connection.id, eventId: span.id, startsAt: span.start, endsAt: span.end, allDay: span.allDay, attendees: span.attendees, direction: 'inbound', ...(moved ? { changed: true } : {}) }
    };
    await upsertSignal(signal);
    signals.push(signal);
  }
  const seen = new Set(spans.map((span) => span.id));
  const windowStart = new Date(timeMin).getTime();
  const stale = [...previous.values()].filter((signal) => !seen.has(signal.sourceId) && new Date(String(signal.metadata?.startsAt ?? signal.occurredAt)).getTime() >= windowStart).map((signal) => signal.sourceId);
  await deleteSignalsBySourceIds(connection.userId, 'calendar', stale);
  return { fetched: spans.length, spans, signals };
}
