export type Source = 'gmail' | 'outlook' | 'calendar' | 'github' | 'slack' | 'manual';
export type Priority = 'now' | 'soon' | 'later';
export type AiProvider = 'rules' | 'chatgpt-subscription' | 'openai' | 'anthropic' | 'openai-compatible';

export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  createdAt: string;
}

export interface Connection {
  id: string;
  userId: string;
  provider: Source;
  label: string;
  accountEmail?: string;
  status: 'connected' | 'available' | 'coming_soon' | 'error';
  lastSyncedAt?: string;
  lastSyncAttemptAt?: string;
  lastSyncError?: string;
  encryptedTokens?: string;
}

export interface Signal {
  id: string;
  userId: string;
  source: Source;
  sourceId: string;
  sender: string;
  title: string;
  summary: string;
  occurredAt: string;
  category: 'action' | 'waiting' | 'calendar' | 'money' | 'travel' | 'people' | 'noise';
  priority: Priority;
  read: boolean;
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  userId: string;
  title: string;
  note?: string;
  dueAt?: string;
  priority: Priority;
  status: 'open' | 'done' | 'snoozed';
  source: Source;
  sourceSignalId?: string;
  createdAt: string;
}

export interface Brief {
  headline: string;
  narrative: string;
  wins: string[];
  watchouts: string[];
  generatedAt: string;
}

export interface ActivityEvent {
  id: string;
  userId: string;
  type: 'sync' | 'ai' | 'connection' | 'settings' | 'data';
  status: 'info' | 'success' | 'error';
  title: string;
  detail?: string;
  action?: string;
  createdAt: string;
}

export interface UserSettings {
  aiProvider: AiProvider;
  aiInputChars: number;
  chatgptModel?: string;
  autoSync: boolean;
  syncIntervalMinutes: number;
  syncLookbackDays: number;
  initialSyncLookbackDays: number;
  syncMaxMessages: number;
  initialSyncMaxMessages: number;
  excludePromotions: boolean;
  excludeSocial: boolean;
  excludeForums: boolean;
  blockedSenders: string[];
  blockedKeywords: string[];
}

export interface DashboardData {
  user: User;
  mode: 'demo' | 'live';
  greeting: string;
  brief: Brief;
  signals: Signal[];
  tasks: Task[];
  connections: Connection[];
  settings: UserSettings;
  activity: ActivityEvent[];
  system: { storage: 'postgres' | 'memory'; persistent: boolean; passwordLoginConfigured:boolean; passwordRecoveryAvailable:boolean; aiProviders: Array<{ id: AiProvider; label: string; configured: boolean; external: boolean }>; chatgpt:{connected:boolean;email?:string;hostId?:string} };
  stats: { needsYou: number; waitingOn: number; cleared: number; noiseFiltered: number };
}
