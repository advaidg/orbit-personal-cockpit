import type pg from 'pg';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Tables backed by the generic JSONB `Collection` helper (see collection.ts). */
const BASE_TABLES = [
  'agent_runs',
  'agent_steps',
  'action_proposals',
  'approvals',
  'tool_executions',
  'commitments',
  'memories',
  'reminders',
  'notifications',
  'automations',
  'skills',
  'agent_settings'
] as const;

/** Added in migration 4: pacts shared with other people, federation peers, and chat-channel links. */
const PACT_TABLES = ['pacts', 'federation', 'channel_links'] as const;

export const COLLECTION_TABLES = [...BASE_TABLES, ...PACT_TABLES] as const;

export type CollectionTable = (typeof COLLECTION_TABLES)[number];

function collectionDdl(table: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      unique_key TEXT,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ${table}_user_created_idx ON ${table}(user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS ${table}_unique_idx ON ${table}(user_id, unique_key) WHERE unique_key IS NOT NULL;
  `;
}

/**
 * Ordered, append-only list. Never edit a shipped migration; add a new version instead.
 * Every statement is idempotent so installs that predate version tracking adopt version 1 cleanly.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'baseline schema',
    sql: `
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, avatar TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL, label TEXT NOT NULL, account_email TEXT, status TEXT NOT NULL, last_synced_at TIMESTAMPTZ, last_sync_attempt_at TIMESTAMPTZ, last_sync_error TEXT, encrypted_tokens TEXT, UNIQUE(user_id, provider, account_email));
      ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_sync_error TEXT;
      ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_sync_attempt_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, source TEXT NOT NULL, source_id TEXT NOT NULL, sender TEXT, title TEXT NOT NULL, summary TEXT, occurred_at TIMESTAMPTZ, category TEXT, priority TEXT, read BOOLEAN DEFAULT FALSE, metadata JSONB DEFAULT '{}', UNIQUE(user_id, source, source_id));
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, note TEXT, due_at TIMESTAMPTZ, priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL, source_signal_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS briefs (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data JSONB NOT NULL, generated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, ai_provider TEXT NOT NULL DEFAULT 'rules', ai_input_chars INTEGER NOT NULL DEFAULT 1800, chatgpt_model TEXT, auto_sync BOOLEAN NOT NULL DEFAULT TRUE, sync_interval_minutes INTEGER NOT NULL DEFAULT 30, sync_lookback_days INTEGER NOT NULL DEFAULT 7, initial_sync_lookback_days INTEGER NOT NULL DEFAULT 30, sync_max_messages INTEGER NOT NULL DEFAULT 35, initial_sync_max_messages INTEGER NOT NULL DEFAULT 100, exclude_promotions BOOLEAN NOT NULL DEFAULT TRUE, exclude_social BOOLEAN NOT NULL DEFAULT TRUE, exclude_forums BOOLEAN NOT NULL DEFAULT FALSE, blocked_senders JSONB NOT NULL DEFAULT '[]', blocked_keywords JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ DEFAULT NOW());
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS chatgpt_model TEXT;
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_sync BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sync_interval_minutes INTEGER NOT NULL DEFAULT 30;
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sync_lookback_days INTEGER NOT NULL DEFAULT 7;
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS initial_sync_lookback_days INTEGER NOT NULL DEFAULT 30;
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sync_max_messages INTEGER NOT NULL DEFAULT 35;
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS initial_sync_max_messages INTEGER NOT NULL DEFAULT 100;
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS exclude_promotions BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS exclude_social BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS exclude_forums BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS blocked_senders JSONB NOT NULL DEFAULT '[]';
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS blocked_keywords JSONB NOT NULL DEFAULT '[]';
      CREATE TABLE IF NOT EXISTS chatgpt_connections (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, client_id TEXT, host_id TEXT NOT NULL, email TEXT, subject TEXT, encrypted_credentials TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS owner_auth (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS activity_events (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, action TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS activity_events_user_created_idx ON activity_events(user_id,created_at DESC);
    `
  },
  {
    version: 2,
    name: 'durable job queue',
    sql: `
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        payload JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_at TIMESTAMPTZ,
        locked_by TEXT,
        idempotency_key TEXT,
        progress JSONB,
        result JSONB,
        last_error TEXT,
        cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_idx ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, run_at);
      CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id, created_at DESC);
    `
  },
  {
    version: 3,
    name: 'agent runtime, memory, automations and skills collections',
    sql: BASE_TABLES.map(collectionDdl).join('\n')
  },
  {
    version: 4,
    name: 'pacts, federation and channel links',
    sql: PACT_TABLES.map(collectionDdl).join('\n')
  }
];

const MIGRATION_LOCK_ID = 7_410_001;

export interface MigrationResult {
  applied: number[];
  current: number;
}

/** Applies pending migrations under an advisory lock so concurrent instances cannot race. */
export async function runMigrations(pool: pg.Pool, list: Migration[] = migrations): Promise<MigrationResult> {
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((row) => Number(row.version)));
    for (const migration of [...list].sort((a, b) => a.version - b.version)) {
      if (done.has(migration.version)) continue;
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations(version,name) VALUES($1,$2)', [migration.version, migration.name]);
        await client.query('COMMIT');
        applied.push(migration.version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    const current = Math.max(0, ...list.map((migration) => migration.version));
    return { applied, current };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

export async function migrationStatus(pool: pg.Pool): Promise<{ current: number; latest: number; pending: number }> {
  const latest = Math.max(0, ...migrations.map((migration) => migration.version));
  const { rows } = await pool.query('SELECT COALESCE(MAX(version),0) AS current FROM schema_migrations').catch(() => ({ rows: [{ current: 0 }] }));
  const current = Number(rows[0]?.current ?? 0);
  return { current, latest, pending: migrations.filter((migration) => migration.version > current).length };
}
