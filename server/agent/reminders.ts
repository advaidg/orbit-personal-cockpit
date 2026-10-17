import crypto from 'node:crypto';
import { Collection } from '../collection.js';
import type { Reminder } from './types.js';

export const reminders = new Collection<Reminder>('reminders');

export async function createReminder(userId: string, input: { title: string; remindAt: string; taskId?: string; signalId?: string; commitmentId?: string }, uniqueKey?: string): Promise<{ reminder: Reminder; created: boolean }> {
  const now = new Date().toISOString();
  const reminder: Reminder = { id: crypto.randomUUID(), userId, createdAt: now, status: 'scheduled', title: input.title.slice(0, 200), remindAt: input.remindAt, taskId: input.taskId, signalId: input.signalId, commitmentId: input.commitmentId };
  const result = await reminders.insert(reminder, uniqueKey);
  return { reminder: result.item, created: result.created };
}

export const listReminders = (userId: string, status?: Reminder['status'][]) => reminders.list(userId, { where: status ? { status } : undefined });

export async function dueReminders(now = new Date()): Promise<Reminder[]> {
  return (await reminders.listAllOwners({ where: { status: 'scheduled' } })).filter((reminder) => reminder.remindAt <= now.toISOString());
}

export const markReminderFired = (userId: string, id: string) => reminders.transition(userId, id, ['scheduled'], { status: 'fired', firedAt: new Date().toISOString() });
export const dismissReminder = (userId: string, id: string) => reminders.transition(userId, id, ['scheduled'], { status: 'dismissed' });
