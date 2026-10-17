import { getSettings, saveSettings } from '../server/store.js';
import type { UserSettings } from '../server/types.js';

export async function updateSettingsForTests(userId: string, patch: Partial<UserSettings> | ((owner: unknown) => unknown)): Promise<void> {
  if (typeof patch === 'function') return;
  await saveSettings(userId, { ...(await getSettings(userId)), ...patch });
}
