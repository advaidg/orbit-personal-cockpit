import crypto from 'node:crypto';
import { pool } from './pool.js';
import { diagnose, logSafe, type Diagnosis } from './diagnostics.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type JobPhase = 'queued' | 'fetching' | 'processing' | 'completed';

export interface JobProgress {
  phase: JobPhase;
  done?: number;
  total?: number;
  message?: string;
}

export interface Job {
  id: string;
  kind: string;
  userId: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  idempotencyKey?: string;
  progress?: JobProgress;
  result?: Record<string, unknown>;
  error?: Diagnosis;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface EnqueueInput {
  kind: string;
  userId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 15 * 60_000;
export const STALE_AFTER_MS = 90_000;

/** Exponential backoff with deterministic bounds: base * 2^(attempt-1), capped. `jitter` is 0..1. */
export function backoffDelay(attempt: number, jitter = Math.random(), base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS): number {
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.75 + jitter * 0.5));
}

// ---- storage ---------------------------------------------------------------------------------------------

const memoryJobs = new Map<string, Job>();

export function resetMemoryJobs(): void {
  memoryJobs.clear();
}

export function purgeMemoryJobs(userId: string): void {
  for (const [id, job] of memoryJobs) if (job.userId === userId) memoryJobs.delete(id);
}

function fromRow(row: Record<string, any>): Job {
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value ? String(value) : undefined);
  let error: Diagnosis | undefined;
  if (row.last_error) {
    try {
      error = JSON.parse(row.last_error) as Diagnosis;
    } catch {
      error = { code: 'unexpected', message: String(row.last_error), action: 'Retry the job.', retryable: false };
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    userId: row.user_id ?? null,
    payload: row.payload ?? {},
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: iso(row.run_at)!,
    idempotencyKey: row.idempotency_key ?? undefined,
    progress: row.progress ?? undefined,
    result: row.result ?? undefined,
    error,
    cancelRequested: row.cancel_requested,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    finishedAt: iso(row.finished_at)
  };
}

export async function enqueue(input: EnqueueInput): Promise<{ job: Job; created: boolean }> {
  const now = new Date();
  const job: Job = {
    id: crypto.randomUUID(),
    kind: input.kind,
    userId: input.userId ?? null,
    payload: input.payload ?? {},
    status: 'queued',
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 5,
    runAt: (input.runAt ?? now).toISOString(),
    idempotencyKey: input.idempotencyKey,
    progress: { phase: 'queued' },
    cancelRequested: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  if (!pool) {
    if (job.idempotencyKey) {
      const existing = [...memoryJobs.values()].find((candidate) => candidate.idempotencyKey === job.idempotencyKey);
      if (existing) return { job: { ...existing }, created: false };
    }
    memoryJobs.set(job.id, job);
    return { job: { ...job }, created: true };
  }
  const { rows } = await pool.query(
    `INSERT INTO jobs(id,kind,user_id,payload,status,max_attempts,run_at,idempotency_key,progress) VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`,
    [job.id, job.kind, job.userId, JSON.stringify(job.payload), job.maxAttempts, job.runAt, job.idempotencyKey ?? null, JSON.stringify(job.progress)]
  );
  if (rows[0]) return { job: fromRow(rows[0]), created: true };
  const existing = await pool.query('SELECT * FROM jobs WHERE idempotency_key=$1', [job.idempotencyKey]);
  return { job: fromRow(existing.rows[0]), created: false };
}

export async function getJob(id: string, userId?: string): Promise<Job | null> {
  if (!pool) {
    const job = memoryJobs.get(id);
    return job && (!userId || job.userId === userId) ? { ...job } : null;
  }
  const { rows } = userId ? await pool.query('SELECT * FROM jobs WHERE id=$1 AND user_id=$2', [id, userId]) : await pool.query('SELECT * FROM jobs WHERE id=$1', [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listJobs(userId: string, options: { kind?: string; status?: JobStatus[]; limit?: number } = {}): Promise<Job[]> {
  const limit = options.limit ?? 30;
  if (!pool) {
    // Newest first. Jobs created in the same millisecond keep their creation order (later one first).
    return [...memoryJobs.values()]
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => job.userId === userId && (!options.kind || job.kind === options.kind) && (!options.status || options.status.includes(job.status)))
      .sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt) || b.index - a.index)
      .slice(0, limit)
      .map(({ job }) => ({ ...job }));
  }
  const params: unknown[] = [userId];
  let sql = 'SELECT * FROM jobs WHERE user_id=$1';
  if (options.kind) {
    params.push(options.kind);
    sql += ` AND kind=$${params.length}`;
  }
  if (options.status) {
    params.push(options.status);
    sql += ` AND status = ANY($${params.length}::text[])`;
  }
  params.push(limit);
  const { rows } = await pool.query(`${sql} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return rows.map(fromRow);
}

/** Finds the user's unfinished job of a kind; used to coalesce duplicate manual triggers. */
export async function findActiveJob(userId: string, kind: string): Promise<Job | null> {
  return (await listJobs(userId, { kind, status: ['queued', 'running'], limit: 1 }))[0] ?? null;
}

/** Atomically claims the next due job. Safe across multiple instances (FOR UPDATE SKIP LOCKED). */
export async function claimNext(workerId: string, now = new Date()): Promise<Job | null> {
  if (!pool) {
    const due = [...memoryJobs.values()]
      .filter((job) => job.status === 'queued' && job.runAt <= now.toISOString())
      .sort((a, b) => a.runAt.localeCompare(b.runAt))[0];
    if (!due) return null;
    due.status = 'running';
    due.attempts += 1;
    due.updatedAt = now.toISOString();
    return { ...due };
  }
  const { rows } = await pool.query(
    `UPDATE jobs SET status='running', attempts=attempts+1, locked_at=NOW(), locked_by=$1, updated_at=NOW()
     WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_at <= $2 ORDER BY run_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [workerId, now.toISOString()]
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

/**
 * Requeues jobs whose worker vanished (for example, a redeploy killed the process mid-run).
 * Jobs that already used all attempts are failed with an explanation instead.
 */
export async function recoverStaleJobs(now = new Date(), staleAfterMs = STALE_AFTER_MS): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
  const interrupted = JSON.stringify({ code: 'interrupted', message: 'The server restarted while this job was running.', action: 'Run it again if the result is still needed.', retryable: true } satisfies Diagnosis);
  if (!pool) {
    let recovered = 0;
    for (const job of memoryJobs.values()) {
      if (job.status !== 'running' || job.updatedAt >= cutoff) continue;
      recovered += 1;
      if (job.attempts >= job.maxAttempts) Object.assign(job, { status: 'failed', error: JSON.parse(interrupted), finishedAt: now.toISOString() });
      else Object.assign(job, { status: 'queued', updatedAt: now.toISOString() });
    }
    return recovered;
  }
  const failed = await pool.query(`UPDATE jobs SET status='failed', last_error=$2, finished_at=NOW(), updated_at=NOW() WHERE status='running' AND updated_at < $1 AND attempts >= max_attempts`, [cutoff, interrupted]);
  const requeued = await pool.query(`UPDATE jobs SET status='queued', locked_at=NULL, locked_by=NULL, updated_at=NOW() WHERE status='running' AND updated_at < $1`, [cutoff]);
  return (failed.rowCount ?? 0) + (requeued.rowCount ?? 0);
}

export async function touchJob(id: string): Promise<void> {
  if (!pool) {
    const job = memoryJobs.get(id);
    if (job) job.updatedAt = new Date().toISOString();
    return;
  }
  await pool.query(`UPDATE jobs SET updated_at=NOW() WHERE id=$1 AND status='running'`, [id]);
}

export async function setProgress(id: string, progress: JobProgress): Promise<void> {
  if (!pool) {
    const job = memoryJobs.get(id);
    if (job) Object.assign(job, { progress, updatedAt: new Date().toISOString() });
    return;
  }
  await pool.query('UPDATE jobs SET progress=$2, updated_at=NOW() WHERE id=$1', [id, JSON.stringify(progress)]);
}

export async function completeJob(id: string, result: Record<string, unknown> = {}): Promise<void> {
  const progress: JobProgress = { phase: 'completed' };
  if (!pool) {
    const job = memoryJobs.get(id);
    if (job && job.status === 'running') Object.assign(job, { status: 'succeeded', result, progress, error: undefined, finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    return;
  }
  await pool.query(`UPDATE jobs SET status='succeeded', result=$2, progress=$3, last_error=NULL, finished_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='running'`, [id, JSON.stringify(result), JSON.stringify(progress)]);
}

/** Records a failure. Retryable failures are rescheduled with exponential backoff until attempts run out. */
export async function failJob(job: Job, error: unknown, now = new Date()): Promise<{ willRetry: boolean; diagnosis: Diagnosis }> {
  const diagnosis = diagnose(error);
  const canceled = (await getJob(job.id))?.cancelRequested;
  const willRetry = diagnosis.retryable && job.attempts < job.maxAttempts && !canceled;
  const runAt = new Date(now.getTime() + backoffDelay(job.attempts)).toISOString();
  if (!pool) {
    const stored = memoryJobs.get(job.id);
    if (stored) {
      if (willRetry) Object.assign(stored, { status: 'queued', runAt, error: diagnosis, updatedAt: now.toISOString() });
      else Object.assign(stored, { status: canceled ? 'canceled' : 'failed', error: diagnosis, finishedAt: now.toISOString(), updatedAt: now.toISOString() });
    }
    return { willRetry, diagnosis };
  }
  if (willRetry) await pool.query(`UPDATE jobs SET status='queued', run_at=$2, last_error=$3, locked_at=NULL, locked_by=NULL, updated_at=NOW() WHERE id=$1`, [job.id, runAt, JSON.stringify(diagnosis)]);
  else await pool.query(`UPDATE jobs SET status=$3, last_error=$2, finished_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='running'`, [job.id, JSON.stringify(diagnosis), canceled ? 'canceled' : 'failed']);
  return { willRetry, diagnosis };
}

const abortControllers = new Map<string, AbortController>();

/** Cancels a queued job immediately, or flags a running job so its handler stops at the next checkpoint. */
export async function cancelJob(userId: string, id: string): Promise<Job | null> {
  const job = await getJob(id, userId);
  if (!job || job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') return job;
  abortControllers.get(id)?.abort();
  if (!pool) {
    const stored = memoryJobs.get(id)!;
    if (stored.status === 'queued') Object.assign(stored, { status: 'canceled', finishedAt: new Date().toISOString() });
    stored.cancelRequested = true;
    stored.updatedAt = new Date().toISOString();
    return { ...stored };
  }
  await pool.query(`UPDATE jobs SET cancel_requested=TRUE, status=CASE WHEN status='queued' THEN 'canceled' ELSE status END, finished_at=CASE WHEN status='queued' THEN NOW() ELSE finished_at END, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [id, userId]);
  return getJob(id, userId);
}

export async function pruneFinishedJobs(olderThanDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  if (!pool) {
    let removed = 0;
    for (const [id, job] of memoryJobs) {
      if (['succeeded', 'failed', 'canceled'].includes(job.status) && (job.finishedAt ?? job.createdAt) < cutoff.toISOString()) {
        memoryJobs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
  const result = await pool.query(`DELETE FROM jobs WHERE status IN ('succeeded','failed','canceled') AND COALESCE(finished_at, created_at) < $1`, [cutoff.toISOString()]);
  return result.rowCount ?? 0;
}

// ---- worker ----------------------------------------------------------------------------------------------

export class JobCanceledError extends Error {
  constructor() {
    super('Job canceled');
    this.name = 'JobCanceledError';
  }
}

export interface JobContext {
  job: Job;
  signal: AbortSignal;
  progress(update: JobProgress): Promise<void>;
  /** Throws JobCanceledError if the owner canceled this job (checks the shared database flag). */
  throwIfCanceled(): Promise<void>;
}

export type JobHandler = (context: JobContext) => Promise<Record<string, unknown> | void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

export async function runJob(job: Job): Promise<void> {
  const handler = handlers.get(job.kind);
  const controller = new AbortController();
  abortControllers.set(job.id, controller);
  const heartbeat = setInterval(() => void touchJob(job.id).catch(() => undefined), 15_000);
  try {
    if (!handler) throw new Error(`No handler is registered for job kind "${job.kind}"`);
    const context: JobContext = {
      job,
      signal: controller.signal,
      progress: (update) => setProgress(job.id, update),
      throwIfCanceled: async () => {
        if (controller.signal.aborted || (await getJob(job.id))?.cancelRequested) throw new JobCanceledError();
      }
    };
    await context.throwIfCanceled();
    const result = await handler(context);
    await context.throwIfCanceled();
    await completeJob(job.id, result ?? {});
  } catch (error) {
    if (error instanceof JobCanceledError) await markCanceled(job.id);
    else {
      logSafe(`job ${job.kind} failed`, error);
      await failJob(job, error);
    }
  } finally {
    clearInterval(heartbeat);
    abortControllers.delete(job.id);
  }
}

async function markCanceled(id: string): Promise<void> {
  if (!pool) {
    const job = memoryJobs.get(id);
    if (job) Object.assign(job, { status: 'canceled', finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    return;
  }
  await pool.query(`UPDATE jobs SET status='canceled', finished_at=NOW(), updated_at=NOW() WHERE id=$1`, [id]);
}

export interface WorkerOptions {
  concurrency?: number;
  pollMs?: number;
}

/** Polls the durable queue. Start one per process; multiple instances cooperate through row locking. */
export function startJobWorker(options: WorkerOptions = {}): { stop: () => Promise<void> } {
  const workerId = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const concurrency = options.concurrency ?? 2;
  const pollMs = options.pollMs ?? 1_500;
  let running = 0;
  let stopped = false;
  const inflight = new Set<Promise<void>>();

  const tick = async () => {
    if (stopped) return;
    try {
      await recoverStaleJobs();
      while (!stopped && running < concurrency) {
        const job = await claimNext(workerId);
        if (!job) break;
        running += 1;
        const task = runJob(job).finally(() => {
          running -= 1;
          inflight.delete(task);
        });
        inflight.add(task);
      }
    } catch (error) {
      logSafe('job worker tick failed', error);
    }
  };

  const timer = setInterval(() => void tick(), pollMs);
  void tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await Promise.allSettled([...inflight]);
    }
  };
}

/** Test helper: drains the queue deterministically without timers. */
export async function drainJobs(workerId = 'test', limit = 100): Promise<number> {
  let processed = 0;
  while (processed < limit) {
    const job = await claimNext(workerId);
    if (!job) break;
    await runJob(job);
    processed += 1;
  }
  return processed;
}
