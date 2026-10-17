import { Collection, type Owned } from './collection.js';
import { decrypt, encrypt } from './crypto.js';
import { logSafe } from './diagnostics.js';
import { pool } from './pool.js';

/**
 * Settings the owner can manage from the Setup screen instead of environment variables. Values are encrypted
 * with APP_ENCRYPTION_KEY before they are stored and are never sent back to the browser. A value set here
 * wins over the same name in the environment; removing it falls back to the environment.
 */
export const MANAGED_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'SMTP_URL',
  'DIGEST_FROM',
  'DIGEST_TO',
  'FEDERATION_ENABLED',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'AI_BASE_URL',
  'AI_COMPATIBLE_MODEL',
  'AI_COMPATIBLE_API_KEY'
] as const;

export type ManagedKey = (typeof MANAGED_KEYS)[number];

interface ConfigRow extends Owned {
  key: ManagedKey;
  /** AES-256-GCM ciphertext of the JSON-encoded value. */
  encryptedValue: string;
  updatedAt: string;
}

const rows = new Collection<ConfigRow>('installation_config');
let cache = new Map<ManagedKey, string>();
const listeners = new Set<(key: ManagedKey) => void>();

const isManaged = (key: string): key is ManagedKey => (MANAGED_KEYS as readonly string[]).includes(key);

/** Loads every stored value into memory. Called once at startup (and by tests after resetting). */
export async function loadInstallationConfig(): Promise<void> {
  const next = new Map<ManagedKey, string>();
  for (const row of await rows.listAllOwners()) {
    try {
      if (isManaged(row.key)) next.set(row.key, decrypt<string>(row.encryptedValue));
    } catch (error) {
      logSafe(`could not read setting ${row.key} (was APP_ENCRYPTION_KEY changed?)`, error);
    }
  }
  cache = next;
}

/** Forgets cached values without touching storage (tests). */
export function resetInstallationConfig(): void {
  cache = new Map();
}

/** The value in force: the one set in the UI, otherwise the environment. Empty strings count as unset. */
export function setting(key: ManagedKey, env: Record<string, string | undefined> = process.env): string | undefined {
  const ui = env === process.env ? cache.get(key) : undefined;
  if (ui !== undefined && ui !== '') return ui;
  const fromEnv = env[key];
  return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
}

export type SettingSource = 'ui' | 'env' | 'unset';

export function settingSource(key: ManagedKey): SettingSource {
  if (cache.has(key) && cache.get(key) !== '') return 'ui';
  return process.env[key] ? 'env' : 'unset';
}

export function onSettingChange(listener: (key: ManagedKey) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stores (or replaces) a value for the owner. In memory mode it lives until restart, like all other data. */
export async function saveSetting(userId: string, key: ManagedKey, value: string): Promise<void> {
  if (!isManaged(key)) throw new Error(`${key} cannot be managed from the UI`);
  const now = new Date().toISOString();
  const row: ConfigRow = { id: `config:${key}`, userId, createdAt: now, key, encryptedValue: encrypt(value), updatedAt: now };
  const { created } = await rows.insert(row, key);
  if (!created) await rows.update(userId, row.id, { encryptedValue: row.encryptedValue, updatedAt: now });
  cache.set(key, value);
  for (const listener of listeners) listener(key);
}

/** Removes the UI value so the environment (if any) applies again. */
export async function clearSetting(userId: string, key: ManagedKey): Promise<void> {
  await rows.delete(userId, `config:${key}`);
  cache.delete(key);
  for (const listener of listeners) listener(key);
}

/** Whether values survive a restart. The Setup screen warns when they would not. */
export const settingsPersist = (): boolean => !!pool;
