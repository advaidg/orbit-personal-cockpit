import { z } from 'zod';
import { ActionableError } from '../../diagnostics.js';
import { isoDate, slug } from './util.js';
import { registerTool, type AnyTool } from './registry.js';

/**
 * Creating an event always needs approval. Orbit has no calendar-delete tool: the only way an event it
 * created can be removed is the owner pressing Undo, which is an explicit owner action, never an agent one.
 */
const createCalendarEvent: AnyTool = {
  name: 'create_calendar_event',
  description: 'Create a private event on the owner’s primary Google Calendar. Never adds attendees or sends invitations.',
  risk: 'calendar_write',
  schema: z.object({
    title: z.string().trim().min(1).max(160),
    startsAt: isoDate,
    endsAt: isoDate,
    description: z.string().max(1000).optional(),
    location: z.string().max(200).optional()
  }).refine((value) => value.endsAt > value.startsAt, 'The event must end after it starts')
    .refine((value) => new Date(value.endsAt).getTime() - new Date(value.startsAt).getTime() <= 24 * 3_600_000, 'Events longer than 24 hours are not supported'),
  authorize: async (_input, ctx) => {
    const capability = await ctx.services.calendar.capabilities(ctx.userId);
    if (!capability.connected) throw new ActionableError('Google Calendar is not connected.', { action: 'Connect Calendar in Connections.', code: 'calendar_disconnected' });
    if (!capability.canWrite) throw new ActionableError('Calendar event creation is not enabled.', { action: 'Open Connections, allow Calendar event creation, and approve the Google consent screen.', code: 'calendar_scope' });
  },
  preview: async (input) => ({
    title: `Add to calendar: ${input.title}`,
    description: `${input.startsAt.slice(0, 16).replace('T', ' ')} – ${input.endsAt.slice(11, 16)} UTC${input.location ? ` · ${input.location}` : ''}`,
    dataLeaving: ['The event title, time and notes are saved to your Google Calendar. No one else is invited or notified.'],
    services: ['Google Calendar'],
    editable: ['title', 'startsAt', 'endsAt']
  }),
  dedupeKey: (input) => `event:${slug(input.title)}:${input.startsAt}`,
  execute: async (input, ctx) => {
    const created = await ctx.services.calendar.createEvent(ctx.userId, input);
    return { summary: `Added “${input.title}” to your calendar.`, output: { eventId: created.eventId, htmlLink: created.htmlLink ?? null }, undoable: true };
  },
  verify: async (_input, outcome, ctx) => {
    const found = await ctx.services.calendar.getEvent(ctx.userId, String(outcome.output.eventId));
    return { ok: found.exists, detail: found.exists ? 'The event is on your calendar.' : 'Google Calendar does not show the event.' };
  },
  undo: async (_input, outcome, ctx) => {
    await ctx.services.calendar.deleteEvent(ctx.userId, String(outcome.output.eventId));
    return { summary: 'Removed the event Orbit created.' };
  }
};

export const calendarTools: AnyTool[] = [createCalendarEvent];

export function registerCalendarTools(): void {
  for (const tool of calendarTools) registerTool(tool);
}
