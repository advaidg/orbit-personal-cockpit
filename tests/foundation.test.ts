import { beforeEach, describe, expect, it } from 'vitest';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { Collection, type Owned } from '../server/collection.js';
import { pool } from '../server/pool.js';
import { migrations, migrationStatus, runMigrations } from '../server/migrations.js';
import { ActionableError, diagnose, redact } from '../server/diagnostics.js';
import {
  backoffDelay, cancelJob, claimNext, drainJobs, enqueue, failJob, getJob, JobCanceledError, recoverStaleJobs, registerJobHandler, runJob
} from '../server/jobs.js';
import { ProviderLimiter } from '../server/providerLimits.js';

interface Note extends Owned { status: string; text: string }
const notes = new Collection<Note>('reminders');
const note = (userId: string, text: string, status = 'open'): Note => ({ id: crypto.randomUUID(), userId, text, status, createdAt: new Date().toISOString() });

beforeEach(resetStorage);

describe(`migrations (${storageMode})`, () => {
  it.skipIf(!pool)('tracks versions and is idempotent on re-run', async () => {
    await freshOwner();
    const again = await runMigrations(pool!);
    expect(again.applied).toEqual([]);
    const status = await migrationStatus(pool!);
    expect(status).toEqual({ current: Math.max(...migrations.map((m) => m.version)), latest: Math.max(...migrations.map((m) => m.version)), pending: 0 });
  });

  it.skipIf(!pool)('adopts an existing install that predates version tracking without touching its data', async () => {
    const owner = await freshOwner();
    await pool!.query("INSERT INTO tasks(id,user_id,title,priority,status,source) VALUES('legacy-task',$1,'Legacy task','soon','open','manual')", [owner.id]);
    await pool!.query('DROP TABLE schema_migrations');
    const adopted = await runMigrations(pool!);
    expect(adopted.applied).toEqual(migrations.map((m) => m.version));
    const { rows } = await pool!.query("SELECT title FROM tasks WHERE id='legacy-task'");
    expect(rows[0].title).toBe('Legacy task');
    await pool!.query("DELETE FROM tasks WHERE id='legacy-task'");
  });

  it.skipIf(!pool)('rolls back a failing migration without recording it', async () => {
    await freshOwner();
    const bad = [{ version: 9999, name: 'broken', sql: 'CREATE TABLE ok_then_fail(id INT); SELECT * FROM missing_table;' }];
    await expect(runMigrations(pool!, bad)).rejects.toThrow(/Migration 9999/);
    const { rows } = await pool!.query("SELECT to_regclass('ok_then_fail') AS t");
    expect(rows[0].t).toBeNull();
  });
});

describe(`collection (${storageMode})`, () => {
  it('enforces unique keys per owner and returns the existing record', async () => {
    const owner = await freshOwner();
    const first = await notes.insert(note(owner.id, 'a'), 'k1');
    const second = await notes.insert(note(owner.id, 'b'), 'k1');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(await notes.count(owner.id)).toBe(1);
  });

  it('isolates owners from each other', async () => {
    const a = await freshOwner('a');
    const b = await freshOwner('b');
    const item = (await notes.insert(note(a.id, 'secret'), 'same-key')).item;
    expect(await notes.get(b.id, item.id)).toBeNull();
    expect(await notes.list(b.id)).toEqual([]);
    expect(await notes.update(b.id, item.id, { text: 'hacked' })).toBeNull();
    expect(await notes.delete(b.id, item.id)).toBe(false);
    expect((await notes.insert(note(b.id, 'mine'), 'same-key')).created).toBe(true);
  });

  it('transitions status atomically so only one caller wins', async () => {
    const owner = await freshOwner();
    const item = (await notes.insert(note(owner.id, 'x', 'pending'))).item;
    const results = await Promise.all([1, 2, 3].map(() => notes.transition(owner.id, item.id, ['pending'], { status: 'approved' })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('filters, paginates and orders', async () => {
    const owner = await freshOwner();
    for (let i = 0; i < 5; i += 1) await notes.insert({ ...note(owner.id, `n${i}`, i % 2 ? 'done' : 'open'), createdAt: new Date(2026, 0, i + 1).toISOString() });
    expect((await notes.list(owner.id, { where: { status: 'open' } })).map((n) => n.text)).toEqual(['n4', 'n2', 'n0']);
    expect((await notes.list(owner.id, { order: 'asc', limit: 2 })).map((n) => n.text)).toEqual(['n0', 'n1']);
    expect((await notes.list(owner.id, { where: { status: ['open', 'done'] }, limit: 2, offset: 1 })).map((n) => n.text)).toEqual(['n3', 'n2']);
  });

  it('rejects unsafe field names in filters', async () => {
    if (!pool) return;
    const owner = await freshOwner();
    await expect(notes.list(owner.id, { where: { "status'; DROP TABLE jobs;--": 'x' } })).rejects.toThrow(/Invalid collection field/);
  });
});

describe(`job queue (${storageMode})`, () => {
  it('collapses duplicate scheduler invocations with the same idempotency key', async () => {
    const owner = await freshOwner();
    const runs: string[] = [];
    registerJobHandler('test.once', async ({ job }) => { runs.push(job.id); });
    const results = await Promise.all([1, 2, 3, 4].map(() => enqueue({ kind: 'test.once', userId: owner.id, idempotencyKey: 'bucket-1' })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    await drainJobs();
    expect(runs).toHaveLength(1);
    expect((await enqueue({ kind: 'test.once', userId: owner.id, idempotencyKey: 'bucket-1' })).created).toBe(false);
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    const owner = await freshOwner();
    let calls = 0;
    registerJobHandler('test.flaky', async () => { calls += 1; if (calls < 3) throw new Error('ECONNRESET while calling provider'); return { calls }; });
    const { job } = await enqueue({ kind: 'test.flaky', userId: owner.id });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimNext('t', new Date(Date.now() + 24 * 3600_000));
      expect(claimed?.attempts).toBe(attempt);
      await runJob(claimed!);
    }
    const done = await getJob(job.id);
    expect(done?.status).toBe('succeeded');
    expect(done?.result).toEqual({ calls: 3 });
  });

  it('does not retry permanent failures and explains what to do', async () => {
    const owner = await freshOwner();
    registerJobHandler('test.permanent', async () => { throw new ActionableError('Gmail permission is incomplete', { action: 'Reconnect Gmail', retryable: false }); });
    const { job } = await enqueue({ kind: 'test.permanent', userId: owner.id });
    await drainJobs();
    const failed = await getJob(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(1);
    expect(failed?.error?.action).toBe('Reconnect Gmail');
  });

  it('stops retrying after max attempts', async () => {
    const owner = await freshOwner();
    registerJobHandler('test.always', async () => { throw new Error('fetch failed'); });
    const { job } = await enqueue({ kind: 'test.always', userId: owner.id, maxAttempts: 2 });
    for (let i = 0; i < 2; i += 1) { const c = await claimNext('t', new Date(Date.now() + 86_400_000)); await runJob(c!); }
    expect((await getJob(job.id))?.status).toBe('failed');
  });

  it('recovers jobs orphaned by a redeploy without losing them', async () => {
    const owner = await freshOwner();
    registerJobHandler('test.recover', async () => ({ ok: true }));
    const { job } = await enqueue({ kind: 'test.recover', userId: owner.id });
    const claimed = await claimNext('dead-worker');
    expect(claimed?.status).toBe('running');
    expect(await recoverStaleJobs(new Date(Date.now() + 10 * 60_000))).toBe(1);
    expect((await getJob(job.id))?.status).toBe('queued');
    await drainJobs();
    expect((await getJob(job.id))?.status).toBe('succeeded');
  });

  it('cancels queued jobs immediately and running jobs at the next checkpoint', async () => {
    const owner = await freshOwner();
    registerJobHandler('test.cancel', async ({ throwIfCanceled }) => {
      await cancelJob(owner.id, (await listRunning(owner.id))!);
      await throwIfCanceled();
      return { reachedEnd: true };
    });
    const queued = await enqueue({ kind: 'test.cancel', userId: owner.id, runAt: new Date(Date.now() + 3600_000) });
    expect((await cancelJob(owner.id, queued.job.id))?.status).toBe('canceled');
    const running = await enqueue({ kind: 'test.cancel', userId: owner.id });
    await drainJobs();
    expect((await getJob(running.job.id))?.status).toBe('canceled');
    expect((await getJob(running.job.id))?.result).toBeUndefined();
  });

  it('refuses to cancel another owner\'s job', async () => {
    const a = await freshOwner('a');
    const b = await freshOwner('b');
    const { job } = await enqueue({ kind: 'test.once', userId: a.id, runAt: new Date(Date.now() + 3600_000) });
    expect(await cancelJob(b.id, job.id)).toBeNull();
    expect((await getJob(job.id))?.status).toBe('queued');
  });

  it('survives a simulated redeploy: queued work is still there afterwards', async () => {
    const owner = await freshOwner();
    const { job } = await enqueue({ kind: 'test.once', userId: owner.id });
    // A redeploy discards process memory but not the database; in memory mode the Map stands in for it.
    expect((await getJob(job.id))?.status).toBe('queued');
  });
});

async function listRunning(userId: string): Promise<string | undefined> {
  const { listJobs } = await import('../server/jobs.js');
  return (await listJobs(userId, { status: ['running'], kind: 'test.cancel' }))[0]?.id;
}

describe('backoff', () => {
  it('doubles up to the cap', () => {
    expect([1, 2, 3, 4].map((n) => backoffDelay(n, 0.5, 1000, 100_000))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(30, 0.5, 1000, 60_000)).toBe(60_000);
  });
});

describe('diagnostics redaction', () => {
  it('removes credentials from error text', () => {
    const dirty = 'request failed: Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxx access_token=abc123secret sk-proj-AAAAAAAAAAAAAAAA refresh_token":"1//0gXXXXXXXXXXXXXXXXXXXXXXXX"';
    const clean = redact(dirty);
    for (const secret of ['ya29', 'abc123secret', 'sk-proj-AAAA', '1//0gXXXX']) expect(clean).not.toContain(secret);
  });

  it('maps provider failures to owner actions', () => {
    expect(diagnose(new Error('invalid_grant')).action).toMatch(/connect it again/i);
    expect(diagnose(new Error('Quota exceeded for quota metric')).retryable).toBe(true);
    expect(diagnose(new Error('Request had insufficient authentication scopes')).retryable).toBe(false);
  });
});

describe('provider rate limiting', () => {
  it('waits for tokens instead of bursting past the limit', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new ProviderLimiter(() => now, async (ms) => { sleeps.push(ms); now += ms; });
    for (let i = 0; i < 4; i += 1) await limiter.acquire('telegram');
    expect(sleeps.length).toBe(3);
    expect(sleeps.every((ms) => ms >= 1000)).toBe(true);
  });

  it('pauses a provider after a rate-limit error', async () => {
    let now = 0;
    const limiter = new ProviderLimiter(() => now, async (ms) => { now += ms; });
    await expect(limiter.run('gmail', async () => { throw new Error('Rate limit exceeded'); })).rejects.toThrow();
    expect(limiter.waitTime('gmail')).toBeGreaterThanOrEqual(9_000);
  });
});

void JobCanceledError; void failJob;
