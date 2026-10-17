import { Collection } from '../collection.js';
import type { AgentSettings } from './types.js';

const settingsStore = new Collection<AgentSettings>('agent_settings');

export function defaultAgentSettings(userId: string): AgentSettings {
  const now = new Date().toISOString();
  return {
    id: `settings:${userId}`,
    userId,
    createdAt: now,
    updatedAt: now,
    paused: false,
    gmailAccess: 'read',
    automationsKilled: false,
    timezone: 'UTC',
    channels: { browser: true, email: false, telegram: { enabled: false } }
  };
}

export async function getAgentSettings(userId: string): Promise<AgentSettings> {
  return (await settingsStore.get(userId, `settings:${userId}`)) ?? defaultAgentSettings(userId);
}

export type AgentSettingsPatch = Partial<Pick<AgentSettings, 'paused' | 'gmailAccess' | 'automationsKilled' | 'timezone'>> & {
  channels?: Partial<AgentSettings['channels']>;
};

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export async function saveAgentSettings(userId: string, patch: AgentSettingsPatch): Promise<AgentSettings> {
  const current = await getAgentSettings(userId);
  const now = new Date().toISOString();
  const next: AgentSettings = {
    ...current,
    ...(patch.paused === undefined ? {} : { paused: patch.paused, pausedAt: patch.paused ? now : undefined }),
    ...(patch.gmailAccess === undefined ? {} : { gmailAccess: patch.gmailAccess }),
    ...(patch.automationsKilled === undefined ? {} : { automationsKilled: patch.automationsKilled }),
    ...(patch.timezone && isValidTimezone(patch.timezone) ? { timezone: patch.timezone } : {}),
    channels: {
      browser: patch.channels?.browser ?? current.channels.browser,
      email: patch.channels?.email ?? current.channels.email,
      telegram: { ...current.channels.telegram, ...(patch.channels?.telegram ?? {}) }
    },
    updatedAt: now
  };
  const { created } = await settingsStore.insert(next, 'settings');
  if (created) return next;
  return (await settingsStore.update(userId, next.id, next)) ?? next;
}
