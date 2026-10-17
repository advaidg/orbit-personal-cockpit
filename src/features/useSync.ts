import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from '../api';
import type { JobInfo } from '../types';

export interface SyncState {
  running: boolean;
  label: string;
  percent: number | null;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
}

function progressLabel(job: JobInfo): string {
  const progress = job.progress;
  if (job.status === 'queued') return 'Queued';
  if (!progress) return 'Syncing';
  const count = progress.total ? ` ${progress.done ?? 0}/${progress.total}` : '';
  if (progress.phase === 'fetching') return `Fetching${count}`;
  if (progress.phase === 'processing') return `Processing${count}`;
  return progress.message ?? 'Syncing';
}

/** Starts a sync job and follows it through queued → fetching → processing → completed. Resumable after a reload. */
export function useSync(onDone: (message: string) => void, onFinished: () => Promise<void> | void): SyncState {
  const [job, setJob] = useState<JobInfo | null>(null);
  const finished = useRef(onFinished);
  const done = useRef(onDone);
  finished.current = onFinished;
  done.current = onDone;
  const active = useRef<string | null>(null);

  const follow = useCallback(async (jobId: string) => {
    active.current = jobId;
    for (;;) {
      let current: JobInfo;
      try { current = await api.get<JobInfo>(`/api/jobs/${jobId}`); } catch (failure) { done.current(describeError(failure).message); break; }
      if (active.current !== jobId) return;
      setJob(current);
      if (['succeeded', 'failed', 'canceled'].includes(current.status)) {
        active.current = null;
        setJob(null);
        await finished.current();
        if (current.status === 'succeeded') {
          const result = current.result ?? {};
          done.current(!result.connections ? 'Connect Gmail before syncing' : result.processed ? `Sync complete · ${result.processed} new message${result.processed === 1 ? '' : 's'}` : 'Sync complete · no new messages');
        } else if (current.status === 'canceled') done.current('Sync canceled');
        else done.current(`${current.error?.message ?? 'Sync needs attention'} ${current.error?.action ?? ''}`.trim());
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }, []);

  // If a sync is already running (another tab, the scheduler), pick it up.
  useEffect(() => {
    void api.get<{ jobs: JobInfo[] }>('/api/jobs?limit=5').then(({ jobs }) => { const running = jobs.find((item) => (item.kind === 'sync' || item.kind === 'reprocess') && ['queued', 'running'].includes(item.status)); if (running) void follow(running.id); }).catch(() => undefined);
  }, [follow]);

  const start = useCallback(async () => {
    try { const { jobId } = await api.post<{ jobId: string }>('/api/sync'); await follow(jobId); } catch (failure) { done.current(describeError(failure).message); }
  }, [follow]);
  const cancel = useCallback(async () => { if (active.current) await api.post(`/api/jobs/${active.current}/cancel`).catch(() => undefined); }, []);
  const percent = job?.progress?.total ? Math.min(100, Math.round(((job.progress.done ?? 0) / job.progress.total) * 100)) : null;
  return { running: !!job, label: job ? progressLabel(job) : 'Sync now', percent, start, cancel };
}
