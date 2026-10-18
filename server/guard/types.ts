import type { Owned } from '../collection.js';

/** What Orbit tells the agent. `defer` means "no opinion": the agent's own permission prompt applies. */
export type Verdict = 'allow' | 'ask' | 'deny' | 'defer';
export type Strictness = 'relaxed' | 'balanced' | 'strict';
export type DecidedBy = 'policy' | 'rule' | 'owner' | 'timeout' | 'budget';

export interface Classification {
  verdict: Verdict;
  /** Plain-language reasons shown on the approval card ("Deletes files recursively"). */
  reasons: string[];
  /** A short label for grouping in the log: "delete", "deploy", "secrets", "read", ... */
  category: string;
}

/** The part of a Claude Code PreToolUse event Orbit uses. Everything in it is untrusted text. */
export interface HookEvent {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  permission_mode?: string;
}

export interface GuardAgent extends Owned {
  name: string;
  kind: 'claude-code' | 'other';
  /** SHA-256 of the token. The token is shown once and never stored. */
  tokenHash: string;
  tokenHint: string;
  paused: boolean;
  lastSeenAt?: string;
  /** Daily token budget across all sessions of this agent. Empty means no cap. */
  dailyTokenBudget?: number | null;
  revokedAt?: string;
  updatedAt: string;
}

export type RuleMatch = 'exact' | 'glob';

export interface GuardRule extends Owned {
  /** A tool name such as Bash or Edit, or * for any. */
  tool: string;
  match: RuleMatch;
  /** For glob: the pattern, where * matches anything. For exact: a redacted label (the real match uses `valueHash`). */
  value: string;
  /** SHA-256 of the exact command or path, so a command that contained a secret is never stored. */
  valueHash?: string;
  /** Only applies when the agent works under this directory. Empty means everywhere. */
  project?: string;
  action: 'allow' | 'ask' | 'deny';
  note?: string;
  hits: number;
  lastHitAt?: string;
  updatedAt: string;
}

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface GuardRequest extends Owned {
  agentId: string;
  agentName: string;
  sessionId?: string;
  tool: string;
  /** What the owner sees: a redacted, truncated rendering of the call. Never file contents. */
  summary: string;
  project?: string;
  /** Full working directory, used only to scope a remembered rule. */
  cwd?: string;
  /** SHA-256 of the exact command or path being asked about. */
  subjectHash?: string;
  reasons: string[];
  category: string;
  status: RequestStatus;
  decidedBy?: DecidedBy;
  decidedAt?: string;
  /** Set when the owner chose "always allow this exact call here". */
  remembered?: boolean;
  notifiedTelegram?: boolean;
  expiresAt: string;
  updatedAt: string;
}

export interface GuardEvent extends Owned {
  agentId: string;
  agentName: string;
  sessionId?: string;
  tool: string;
  summary: string;
  project?: string;
  category: string;
  reasons: string[];
  verdict: Verdict;
  decidedBy: DecidedBy;
  /** Time the agent waited on this call, in milliseconds. */
  waitedMs: number;
  requestId?: string;
  ruleId?: string;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One day of one agent's token use. `sessions` keeps each session's last cumulative totals so replays never double-count. */
export interface GuardUsage extends Owned {
  agentId: string;
  day: string;
  totals: UsageTotals;
  sessions: Record<string, UsageTotals>;
  budgetNotified?: boolean;
  updatedAt: string;
}

export interface GuardSettings extends Owned {
  strictness: Strictness;
  /** How long a hook waits for the owner's answer before handing control back to the agent. */
  waitSeconds: number;
  /** What to do when nobody answers in time: hand back to the agent's own prompt, or refuse. */
  onTimeout: 'defer' | 'deny';
  /** Optional price per million tokens, so usage can be shown in dollars. */
  usdPerMillion?: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  dailyDigest: boolean;
  lastDigestDay?: string;
  updatedAt: string;
}
