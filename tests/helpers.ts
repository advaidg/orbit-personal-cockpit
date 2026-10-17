import crypto from 'node:crypto';
import { pool } from '../server/pool.js';
import { initStore, upsertUser } from '../server/store.js';
import { resetMemoryCollections } from '../server/collection.js';
import { resetMemoryJobs } from '../server/jobs.js';
import { COLLECTION_TABLES } from '../server/migrations.js';
import { resetInstallationConfig } from '../server/installationConfig.js';
import type { User } from '../server/types.js';

let initialized = false;

/** Initializes storage once per test file and returns a fresh owner for isolation between tests. */
async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  await initStore();
  initialized = true;
}

export async function freshOwner(label = 'owner'): Promise<User> {
  await ensureInitialized();
  const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const user: User = { id, email: `${id}@example.test`, name: label, createdAt: new Date().toISOString() };
  await upsertUser(user);
  return user;
}

export async function resetStorage(): Promise<void> {
  await ensureInitialized();
  resetMemoryCollections();
  resetMemoryJobs();
  resetInstallationConfig();
  if (!pool) return;
  await pool.query(`TRUNCATE jobs, ${COLLECTION_TABLES.join(', ')}`);
}

export const storageMode = pool ? 'postgres' : 'memory';
