import { ActionableError } from '../diagnostics.js';
import { getSettings, getSignal, getUser } from '../store.js';
import { composeDraft } from './compose.js';
import { shareableMemories } from './memory.js';
import { proposeCalls, type PlannedCall, type ProposeResult } from './proposals.js';
import { startRun } from './runs.js';
import { displayName, extractEmail } from './tools/util.js';
import type { AgentRun } from './types.js';

export const SIGNAL_ACTIONS = ['draft_reply', 'create_task', 'waiting_on', 'i_owe', 'deadline', 'snooze', 'ignore_sender', 'priority_person', 'resolve', 'noise', 'remind'] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];

export interface SignalActionParams {
  action?: string;
  dueAt?: string;
  until?: string;
  remindAt?: string;
  title?: string;
}

const LABEL: Record<SignalAction, string> = {
  draft_reply: 'Draft a reply', create_task: 'Create a follow-up task', waiting_on: 'Track as waiting-on', i_owe: 'Track as something you owe', deadline: 'Extract a deadline',
  snooze: 'Snooze', ignore_sender: 'Ignore sender', priority_person: 'Add to priority people', resolve: 'Mark resolved', noise: 'Mark as noise', remind: 'Set a reminder'
};

/** Turns an owner's click on a message into a validated, previewed proposal. */
export async function proposeSignalAction(userId: string, signalId: string, action: SignalAction, params: SignalActionParams = {}): Promise<{ run: AgentRun } & ProposeResult> {
  const signal = await getSignal(userId, signalId);
  if (!signal) throw new ActionableError('That message is no longer in Orbit.', { action: 'Refresh and try again.', code: 'not_found' });
  const fromAddress = typeof signal.metadata?.fromAddress === 'string' ? signal.metadata.fromAddress : extractEmail(signal.sender);
  const person = displayName(signal.sender);
  const reason = `You chose “${LABEL[action]}” on “${signal.title}”.`;
  let call: PlannedCall;

  switch (action) {
    case 'draft_reply': {
      const [user, settings, preferences] = await Promise.all([getUser(userId), getSettings(userId), shareableMemories(userId)]);
      const draft = await composeDraft({ ownerName: user?.name ?? '', signal, kind: 'reply', preferences: preferences.filter((memory) => memory.type === 'communication_preference').map((memory) => memory.statement), settings, userId });
      call = { tool: 'draft_reply', input: { signalId, body: draft.body, kind: 'reply', round: 1 }, reason, sourceSignalId: signalId, generatedBy: draft.generatedBy };
      break;
    }
    case 'create_task':
      call = { tool: 'create_task', input: { title: params.title || `Follow up: ${signal.title}`, priority: signal.priority, sourceSignalId: signalId, dueAt: params.dueAt }, reason, sourceSignalId: signalId };
      break;
    case 'waiting_on':
    case 'i_owe':
      call = { tool: 'mark_waiting_on', input: { signalId, direction: action === 'i_owe' ? 'i_owe' : 'they_owe', otherPerson: person, otherEmail: fromAddress, action: params.action || signal.title, expectedAt: params.dueAt, threadId: signal.metadata?.threadId }, reason, sourceSignalId: signalId };
      break;
    case 'deadline':
      if (!params.dueAt) throw new ActionableError('Choose the deadline date first.', { action: 'Pick a date.' });
      call = { tool: 'extract_deadline', input: { signalId, dueAt: params.dueAt, label: signal.title }, reason, sourceSignalId: signalId };
      break;
    case 'snooze':
      if (!params.until) throw new ActionableError('Choose when to bring this back.', { action: 'Pick a date.' });
      call = { tool: 'snooze_signal', input: { signalId, until: params.until }, reason, sourceSignalId: signalId };
      break;
    case 'ignore_sender':
      if (!fromAddress) throw new ActionableError('This message has no sender address to ignore.', { action: 'Mark it as noise instead.' });
      call = { tool: 'ignore_sender', input: { senderEmail: fromAddress, signalId }, reason, sourceSignalId: signalId };
      break;
    case 'priority_person':
      if (!fromAddress) throw new ActionableError('This message has no sender address.', { action: 'Choose a different action.' });
      call = { tool: 'add_priority_person', input: { email: fromAddress, name: person }, reason, sourceSignalId: signalId };
      break;
    case 'resolve':
      call = { tool: 'mark_resolved', input: { signalId }, reason, sourceSignalId: signalId };
      break;
    case 'noise':
      call = { tool: 'mark_signal_noise', input: { signalId }, reason, sourceSignalId: signalId };
      break;
    case 'remind':
      if (!params.remindAt) throw new ActionableError('Choose when to be reminded.', { action: 'Pick a date.' });
      call = { tool: 'create_reminder', input: { title: params.title || `Follow up: ${signal.title}`, remindAt: params.remindAt, signalId }, reason, sourceSignalId: signalId };
      break;
  }

  const run = await startRun(userId, { objective: `${LABEL[action]}: ${signal.title}`, trigger: { type: 'manual', ref: signalId, label: LABEL[action] }, plan: [`${LABEL[action]} for “${signal.title}”.`, 'Show exactly what will change and wait for your approval.'], provider: call.generatedBy ?? 'rules' });
  return { run, ...(await proposeCalls(userId, run, [call])) };
}
