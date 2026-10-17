import { decrypt } from './crypto.js';
import { ActionableError } from './diagnostics.js';
import { calendarClient, canReadCalendar, canWriteCalendar, CALENDAR_EVENTS_SCOPE } from './calendar.js';
import type { GoogleTokens } from './gmail.js';
import { providerLimiter } from './providerLimits.js';
import { getConnections } from './store.js';
import type { CalendarGateway } from './agent/services.js';

async function connectionFor(userId: string) {
  const connection = (await getConnections(userId)).find((candidate) => candidate.provider === 'calendar' && !!candidate.encryptedTokens);
  if (!connection?.encryptedTokens) return null;
  return { connection, tokens: decrypt<GoogleTokens>(connection.encryptedTokens) };
}

const notFound = (error: unknown) => /not found|404|deleted|410/i.test(error instanceof Error ? error.message : '');

/** Orbit creates private events only: attendees are never added and no invitations are emailed. */
export const calendarGateway: CalendarGateway = {
  async capabilities(userId) {
    const found = await connectionFor(userId);
    return found ? { connected: canReadCalendar(found.tokens), canWrite: canWriteCalendar(found.tokens), connectionId: found.connection.id } : { connected: false, canWrite: false };
  },
  async createEvent(userId, event) {
    const found = await connectionFor(userId);
    if (!found) throw new ActionableError('Google Calendar is not connected.', { action: 'Connect Calendar in Connections.', code: 'calendar_disconnected' });
    if (!canWriteCalendar(found.tokens)) throw new ActionableError(`Calendar authorization is missing the ${CALENDAR_EVENTS_SCOPE.split('/').pop()} scope.`, { action: 'Open Connections, allow Calendar event creation, and approve the Google consent screen.', code: 'calendar_scope' });
    const client = calendarClient(found.tokens);
    const { data } = await providerLimiter.run('calendar', () => client.events.insert({ calendarId: 'primary', sendUpdates: 'none', requestBody: { summary: event.title, description: event.description, location: event.location, start: { dateTime: event.startsAt }, end: { dateTime: event.endsAt }, extendedProperties: { private: { orbit: 'true' } } } }));
    if (!data.id) throw new Error('Google Calendar did not return an event id');
    return { eventId: data.id, htmlLink: data.htmlLink ?? undefined };
  },
  async getEvent(userId, eventId) {
    const found = await connectionFor(userId);
    if (!found) return { exists: false };
    try {
      const { data } = await providerLimiter.run('calendar', () => calendarClient(found.tokens).events.get({ calendarId: 'primary', eventId }));
      return { exists: data.status !== 'cancelled', title: data.summary ?? undefined, startsAt: data.start?.dateTime ?? undefined };
    } catch (error) {
      if (notFound(error)) return { exists: false };
      throw error;
    }
  },
  async deleteEvent(userId, eventId) {
    const found = await connectionFor(userId);
    if (!found) throw new ActionableError('Google Calendar is not connected.', { action: 'Connect Calendar in Connections.' });
    try {
      await providerLimiter.run('calendar', () => calendarClient(found.tokens).events.delete({ calendarId: 'primary', eventId, sendUpdates: 'none' }));
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
};
