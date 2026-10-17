import { ActionableError, diagnose, logSafe } from './diagnostics.js';
import { syncCalendarConnection } from './calendar.js';
import { ingestCalendar } from './agent/calendarIngest.js';
import { runSyncUser, type SyncHooks, type SyncSummary } from './gmail.js';
import { getConnections, upsertConnection } from './store.js';

export interface FullSyncSummary extends SyncSummary {
  events: number;
}

/** Syncs Gmail, then Google Calendar. A failure in one source never stops the other from running. */
export async function runFullSync(userId: string, hooks: SyncHooks = {}): Promise<FullSyncSummary> {
  let gmail: SyncSummary = { connections: 0, fetched: 0, processed: 0 };
  let gmailError: unknown;
  try {
    gmail = await runSyncUser(userId, hooks);
  } catch (error) {
    if (error instanceof Error && error.name === 'JobCanceledError') throw error;
    gmailError = error;
  }

  let events = 0;
  const failures: string[] = [];
  let retryable = false;
  const calendars = (await getConnections(userId)).filter((connection) => connection.provider === 'calendar' && !!connection.encryptedTokens && (connection.status === 'connected' || connection.status === 'error'));
  for (const connection of calendars) {
    try {
      const result = await syncCalendarConnection(connection, hooks);
      if (result) {
        events += result.fetched;
        await ingestCalendar(userId, result.spans, result.signals, connection.label).catch((error) => logSafe('calendar ingest', error));
      }
      connection.status = 'connected';
      connection.lastSyncedAt = connection.lastSyncAttemptAt = new Date().toISOString();
      connection.lastSyncError = undefined;
      await upsertConnection(connection);
    } catch (error) {
      if (error instanceof Error && error.name === 'JobCanceledError') throw error;
      const diagnosis = diagnose(error);
      connection.status = 'error';
      connection.lastSyncAttemptAt = new Date().toISOString();
      connection.lastSyncError = `${diagnosis.message} ${diagnosis.action}`;
      retryable = retryable || diagnosis.retryable;
      await upsertConnection(connection);
      failures.push(`${connection.label}: ${connection.lastSyncError}`);
      logSafe(`calendar sync ${connection.label}`, error);
    }
  }

  if (gmailError) throw gmailError;
  if (failures.length) throw new ActionableError(failures.join(' '), { action: 'Open Connections, correct the reported issue, then select Sync now.', retryable, code: 'sync_failed' });
  return { ...gmail, events };
}
