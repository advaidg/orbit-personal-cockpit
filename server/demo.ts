import type { Brief, Connection, Signal, Task, User } from './types.js';

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const ahead = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

export const demoUser: User = {
  id: 'demo-user', email: 'alex@orbit.demo', name: 'Alex Morgan', createdAt: ago(20_000)
};

export const demoConnections: Connection[] = [
  { id: 'gmail-personal', userId: demoUser.id, provider: 'gmail', label: 'Personal Gmail', accountEmail: 'alex@gmail.com', status: 'connected', lastSyncedAt: ago(2) },
  { id: 'gmail-work', userId: demoUser.id, provider: 'gmail', label: 'Work Gmail', accountEmail: 'alex@studio.co', status: 'connected', lastSyncedAt: ago(3) },
  { id: 'calendar', userId: demoUser.id, provider: 'calendar', label: 'Google Calendar', status: 'available' },
  { id: 'outlook', userId: demoUser.id, provider: 'outlook', label: 'Outlook', status: 'coming_soon' },
  { id: 'github', userId: demoUser.id, provider: 'github', label: 'GitHub', status: 'coming_soon' },
  { id: 'slack', userId: demoUser.id, provider: 'slack', label: 'Slack', status: 'coming_soon' }
];

export const demoSignals: Signal[] = [
  { id: 's1', userId: demoUser.id, source: 'gmail', sourceId: 'mail-1', sender: 'Maya Chen', title: 'Final approval needed for the launch', summary: 'Maya needs your sign-off on the launch copy before the 2 PM handoff.', occurredAt: ago(18), category: 'action', priority: 'now', read: false, metadata: { account: 'Work Gmail' } },
  { id: 's2', userId: demoUser.id, source: 'calendar', sourceId: 'cal-1', sender: 'Google Calendar', title: 'Design review moved to 11:30 AM', summary: 'The design review now overlaps with your weekly 1:1. A conflict needs resolving.', occurredAt: ago(42), category: 'calendar', priority: 'now', read: false },
  { id: 's3', userId: demoUser.id, source: 'gmail', sourceId: 'mail-2', sender: 'United Airlines', title: 'Your Austin flight changed', summary: 'Departure moved 55 minutes earlier. Your calendar still shows the old time.', occurredAt: ago(67), category: 'travel', priority: 'soon', read: false, metadata: { account: 'Personal Gmail' } },
  { id: 's4', userId: demoUser.id, source: 'gmail', sourceId: 'mail-3', sender: 'River & Co.', title: 'Invoice #1048 is ready', summary: '$1,280 is due Friday. This looks consistent with last month’s invoice.', occurredAt: ago(110), category: 'money', priority: 'soon', read: true, metadata: { account: 'Personal Gmail' } },
  { id: 's5', userId: demoUser.id, source: 'gmail', sourceId: 'mail-4', sender: 'Jordan Lee', title: 'Re: partnership intro', summary: 'Jordan replied positively and offered Tuesday or Wednesday afternoon.', occurredAt: ago(190), category: 'waiting', priority: 'later', read: true, metadata: { account: 'Work Gmail' } },
  { id: 's6', userId: demoUser.id, source: 'github', sourceId: 'gh-1', sender: 'GitHub', title: 'Two reviews waiting on you', summary: 'PR #184 and #191 have been ready for review since yesterday.', occurredAt: ago(230), category: 'action', priority: 'soon', read: true }
];

export const demoTasks: Task[] = [
  { id: 't1', userId: demoUser.id, title: 'Approve launch copy', note: 'Reply to Maya before the handoff.', dueAt: ahead(2), priority: 'now', status: 'open', source: 'gmail', sourceSignalId: 's1', createdAt: ago(18) },
  { id: 't2', userId: demoUser.id, title: 'Resolve the 11:30 calendar conflict', priority: 'now', status: 'open', source: 'calendar', sourceSignalId: 's2', createdAt: ago(42) },
  { id: 't3', userId: demoUser.id, title: 'Update Austin travel plan', dueAt: ahead(28), priority: 'soon', status: 'open', source: 'gmail', sourceSignalId: 's3', createdAt: ago(67) },
  { id: 't4', userId: demoUser.id, title: 'Pay River & Co. invoice', dueAt: ahead(58), priority: 'soon', status: 'open', source: 'gmail', sourceSignalId: 's4', createdAt: ago(110) }
];

export const demoBrief: Brief = {
  headline: 'Two decisions will unlock the rest of your day.',
  narrative: 'Approve the launch copy and resolve the 11:30 conflict first. Your flight changed, but it can wait until after the design review. Everything else is moving without you.',
  wins: ['Partnership conversation is back in motion', 'No urgent bills or security alerts'],
  watchouts: ['Launch handoff in 2 hours', 'Flight departs 55 minutes earlier'],
  generatedAt: ago(2)
};
