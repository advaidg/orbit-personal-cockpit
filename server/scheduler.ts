import cron from 'node-cron';
import { logSafe } from './diagnostics.js';
import { pruneFinishedJobs } from './jobs.js';
import { enqueueDueSyncs } from './syncJobs.js';
import { notifications, notifier, ownerChannels, createNotification } from './notify.js';
import { getSignal, getSnoozedSignalsDue, getTask, patchSignal, pruneOldSignals } from './store.js';
import { agentLimits } from './agent/config.js';
import { commitments } from './agent/commitments.js';
import { runDueAutomations } from './agent/automations.js';
import { pruneMemories } from './agent/memory.js';
import { dismissReminder, dueReminders, markReminderFired } from './agent/reminders.js';
import { pruneRuns } from './agent/runs.js';
import { getAgentSettings } from './agent/settings.js';

export interface TickSummary {
  remindersFired: number;
  remindersDismissed: number;
  snoozesWoken: number;
  automationsRun: number;
  syncsQueued: number;
}

/**
 * Fires due reminders exactly once. A reminder whose purpose is already served (the commitment was closed,
 * the task was completed) is dismissed quietly instead of nagging the owner.
 */
export async function fireDueReminders(now = new Date()): Promise<{ fired: number; dismissed: number }> {
  let fired = 0;
  let dismissed = 0;
  for (const reminder of await dueReminders(now)) {
    const settings = await getAgentSettings(reminder.userId);
    if (settings.paused) continue;
    if (reminder.commitmentId) {
      const commitment = await commitments.get(reminder.userId, reminder.commitmentId);
      if (!commitment || !['open', 'snoozed'].includes(commitment.status)) {
        if (await dismissReminder(reminder.userId, reminder.id)) dismissed += 1;
        continue;
      }
    }
    if (reminder.taskId) {
      const task = await getTask(reminder.userId, reminder.taskId);
      if (!task || task.status === 'done') {
        if (await dismissReminder(reminder.userId, reminder.id)) dismissed += 1;
        continue;
      }
    }
    // The compare-and-set makes this safe when two instances tick at the same moment.
    if (!(await markReminderFired(reminder.userId, reminder.id))) continue;
    fired += 1;
    await notifier.deliver(reminder.userId, { title: reminder.title, body: 'This is the reminder you asked Orbit to set.', kind: 'reminder', link: reminder.signalId ? `/#signal-${reminder.signalId}` : undefined }, await ownerChannels(reminder.userId)).catch((error) => logSafe('reminder delivery', error));
  }
  return { fired, dismissed };
}

/** Brings snoozed messages back once their time has passed. */
export async function wakeSnoozedSignals(now = new Date()): Promise<number> {
  let woken = 0;
  for (const signal of await getSnoozedSignalsDue(now)) {
    if ((await getAgentSettings(signal.userId)).paused) continue;
    const current = await getSignal(signal.userId, signal.id);
    if ((current?.metadata?.state as { status?: string } | undefined)?.status !== 'snoozed') continue;
    await patchSignal(signal.userId, signal.id, { metadata: { state: { status: 'open', wokeAt: now.toISOString() } } });
    await createNotification(signal.userId, { title: 'A snoozed message is back', body: signal.title, kind: 'info', link: `/#signal-${signal.id}` });
    woken += 1;
  }
  return woken;
}

let lastTick: Date | null = null;
export const lastTickAt = (): Date | null => lastTick;

export async function tick(now = new Date()): Promise<TickSummary> {
  lastTick = new Date();
  const reminders = await fireDueReminders(now).catch((error) => (logSafe('reminders', error), { fired: 0, dismissed: 0 }));
  const snoozesWoken = await wakeSnoozedSignals(now).catch((error) => (logSafe('snoozes', error), 0));
  const limits = agentLimits();
  const automationsRun = limits.enabled && limits.automationsEnabled ? await runDueAutomations(now).catch((error) => (logSafe('automations', error), 0)) : 0;
  const syncsQueued = await enqueueDueSyncs(now).catch((error) => (logSafe('sync scheduling', error), 0));
  return { remindersFired: reminders.fired, remindersDismissed: reminders.dismissed, snoozesWoken, automationsRun, syncsQueued };
}

/** Daily housekeeping: retention for signals, runs, jobs, memories and notifications. */
export async function housekeeping(now = new Date()): Promise<void> {
  await pruneOldSignals();
  await pruneRuns(now);
  await pruneFinishedJobs(Math.max(7, agentLimits().runRetentionDays));
  await pruneMemories();
  await notifications.pruneBefore(new Date(now.getTime() - 30 * 86_400_000));
}

export function startScheduler(): { stop: () => void } {
  // One tick per minute drives reminders, automations and sync scheduling. Per-owner sync intervals are
  // enforced inside enqueueDueSyncs, so SYNC_CRON no longer needs to be tuned for them.
  const tickTask = cron.schedule('* * * * *', () => void tick().catch((error) => logSafe('scheduler tick', error)));
  const cleanupTask = cron.schedule('17 3 * * *', () => void housekeeping().catch((error) => logSafe('housekeeping', error)));
  return { stop: () => { tickTask.stop(); cleanupTask.stop(); } };
}
