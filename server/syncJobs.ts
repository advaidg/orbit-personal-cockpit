import { enqueue, findActiveJob, registerJobHandler, type Job } from './jobs.js';
import { runFullSync } from './sync.js';
import { clearDerivedData, getConnections, getSettings, logActivity, pool } from './store.js';

/** Queues a sync for the owner. Manual presses coalesce into one in-flight job; schedules dedupe per time bucket. */
export async function enqueueSync(userId: string, options: { trigger: 'manual' | 'schedule'; bucket?: string } = { trigger: 'manual' }): Promise<{ job: Job; created: boolean }> {
  if (options.trigger === 'schedule' && options.bucket) return enqueue({ kind: 'sync', userId, payload: { trigger: 'schedule' }, idempotencyKey: `sync:${userId}:${options.bucket}`, maxAttempts: 3 });
  const active = await findActiveJob(userId, 'sync');
  if (active) return { job: active, created: false };
  return enqueue({ kind: 'sync', userId, payload: { trigger: options.trigger }, maxAttempts: 3 });
}

export async function enqueueReprocess(userId: string): Promise<{ job: Job; created: boolean }> {
  const active = (await findActiveJob(userId, 'reprocess')) ?? (await findActiveJob(userId, 'sync'));
  if (active) return { job: active, created: false };
  return enqueue({ kind: 'reprocess', userId, payload: {}, maxAttempts: 1 });
}

export function registerSyncJobs(): void {
  registerJobHandler('sync', async ({ job, progress, throwIfCanceled }) => {
    if (!job.userId) throw new Error('Sync job has no owner');
    await progress({ phase: 'fetching', message: 'Starting sync' });
    const summary = await runFullSync(job.userId, { progress, throwIfCanceled });
    return { ...summary };
  });

  registerJobHandler('reprocess', async ({ job, progress, throwIfCanceled }) => {
    if (!job.userId) throw new Error('Reprocess job has no owner');
    await progress({ phase: 'processing', message: 'Clearing AI-derived data' });
    await logActivity(job.userId, { type: 'data', status: 'info', title: 'Rebuild requested', detail: 'Clearing AI-derived signals, brief, and email-generated tasks. Connections, manual tasks, approved suggestions and agent history remain.' }).catch(console.error);
    const removed = await clearDerivedData(job.userId);
    await throwIfCanceled();
    try {
      const synced = await runFullSync(job.userId, { progress, throwIfCanceled });
      await logActivity(job.userId, { type: 'data', status: 'success', title: 'Rebuild completed', detail: `Removed ${removed.signals} signals and ${removed.tasks} email-generated tasks, then processed ${synced.processed} messages.` }).catch(console.error);
      return { removed, ...synced };
    } catch (error) {
      await logActivity(job.userId, { type: 'data', status: 'error', title: 'Rebuild needs attention', detail: 'Derived data was cleared, but Gmail could not be processed again.', action: 'Review the preceding sync error, correct Settings, and run Clear & re-sync again.' }).catch(console.error);
      throw error;
    }
  });
}

/** Called by the scheduler: queues a sync for every owner whose interval has elapsed. */
export async function enqueueDueSyncs(now = new Date()): Promise<number> {
  if (!pool) return 0;
  const { rows } = await pool.query("SELECT DISTINCT user_id FROM connections WHERE provider IN ('gmail','calendar') AND status IN ('connected','error')");
  let queued = 0;
  for (const row of rows) {
    const [settings, connections] = await Promise.all([getSettings(row.user_id), getConnections(row.user_id)]);
    if (!settings.autoSync) continue;
    const due = connections.filter((connection) => connection.provider === 'gmail' || connection.provider === 'calendar').some((connection) => {
      const last = connection.lastSyncAttemptAt || connection.lastSyncedAt;
      return !last || now.getTime() - new Date(last).getTime() >= settings.syncIntervalMinutes * 60_000;
    });
    if (!due) continue;
    const bucket = String(Math.floor(now.getTime() / (settings.syncIntervalMinutes * 60_000)));
    const { created } = await enqueueSync(row.user_id, { trigger: 'schedule', bucket });
    if (created) queued += 1;
  }
  return queued;
}
