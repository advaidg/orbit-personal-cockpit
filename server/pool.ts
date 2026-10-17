import pg from 'pg';

/** Shared PostgreSQL pool. `null` means the zero-setup in-memory mode is active. */
export const pool: pg.Pool | null = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
    })
  : null;
