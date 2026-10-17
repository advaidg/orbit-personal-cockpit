import pg from 'pg';

type Env = Record<string, string | undefined>;

/**
 * Managed hosts (Railway, Neon, Supabase) need TLS; a Postgres container next to the app does not offer it.
 * `DATABASE_SSL=true|false` always wins; otherwise TLS is used in production unless the URL says
 * `sslmode=disable` or points at this machine or a bare compose service name such as `postgres`.
 */
export function wantsSsl(url: string, env: Env = process.env): boolean {
  const override = env.DATABASE_SSL?.trim().toLowerCase();
  if (override) return ['true', '1', 'yes', 'on', 'require'].includes(override);
  if (env.NODE_ENV !== 'production') return false;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get('sslmode') === 'disable') return false;
    const host = parsed.hostname.toLowerCase();
    return !(['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) || !host.includes('.'));
  } catch {
    return env.NODE_ENV === 'production';
  }
}

/** Shared PostgreSQL pool. `null` means the zero-setup in-memory mode is active. */
export const pool: pg.Pool | null = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: wantsSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined })
  : null;
