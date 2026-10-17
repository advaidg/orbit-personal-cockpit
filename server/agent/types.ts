import type { Owned } from '../collection.js';
import type { AiProvider } from '../types.js';

/** How dangerous a tool is. The policy engine decides approval behaviour from this class alone. */
export type ToolRisk =
  | 'read' // reads Orbit's own stored data; no side effects
  | 'local' // changes only Orbit's own database
  | 'notify' // delivers a message to the owner's own channel
  | 'draft' // creates a draft in a provider account (never sends)
  | 'calendar_write' // creates a provider calendar event
  | 'send' // sends mail or messages to other people
  | 'delete' // deletes provider data
  | 'financial' // moves money or buys something
  | 'shell' // runs arbitrary code
  | 'skill_admin' // installs, enables or modifies skills / MCP servers
  | 'skill_read' // an enabled skill reads from an external service
  | 'skill_write'; // an enabled skill changes something at an external service

export type ApprovalMode = 'automatic' | 'ask' | 'prohibited';

export interface PolicyDecision {
  mode: ApprovalMode;
  reason: string;
  /** Whether the owner may turn this tool into an "always allow" rule. */
  alwaysAllowable: boolean;
}

export type RunStatus = 'planning' | 'awaiting_approval' | 'executing' | 'succeeded' | 'failed' | 'canceled';
export type RunTrigger = 'manual' | 'signal' | 'automation' | 'ask' | 'schedule' | 'sync';

export interface AgentRun extends Owned {
  trigger: { type: RunTrigger; ref?: string; label?: string };
  objective: string;
  /** Concise, user-readable plan. Never hidden chain-of-thought. */
  plan: string[];
  provider: AiProvider;
  status: RunStatus;
  dryRun: boolean;
  automationId?: string;
  /** Answer text for read-only requests such as "Who am I waiting on?". */
  answer?: string;
  result?: string;
  error?: { code: string; message: string; action: string };
  cancelRequested?: boolean;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
}

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'rejected' | 'blocked' | 'canceled';

export interface AgentStep extends Owned {
  runId: string;
  index: number;
  kind: 'plan' | 'tool' | 'verify' | 'note';
  title: string;
  status: StepStatus;
  detail?: string;
  toolName?: string;
  proposalId?: string;
  updatedAt: string;
}

export type ProposalStatus = 'pending' | 'approved' | 'executing' | 'executed' | 'failed' | 'rejected' | 'canceled' | 'blocked' | 'previewed';

export interface ProposalPreview {
  title: string;
  description: string;
  /** What will leave this installation, in plain language. Empty means nothing leaves. */
  dataLeaving: string[];
  /** External services that will be modified. Empty for Orbit-local changes. */
  services: string[];
  /** Editable fields the owner may change before approving. */
  editable?: string[];
}

export interface ActionProposal extends Owned {
  runId: string;
  toolName: string;
  risk: ToolRisk;
  input: Record<string, unknown>;
  originalInput?: Record<string, unknown>;
  preview: ProposalPreview;
  /** Why Orbit recommends this action. */
  reason: string;
  status: ProposalStatus;
  decidedBy?: 'owner' | 'policy';
  policyReason: string;
  alwaysAllowable: boolean;
  sourceSignalId?: string;
  idempotencyKey: string;
  jobId?: string;
  blockedReason?: string;
  lastError?: { code: string; message: string; action: string };
  feedback?: 'helpful' | 'not_helpful';
  generatedBy?: AiProvider;
  /** Set once the proposal was shown in the owner's linked Telegram chat, so it is announced only once. */
  telegramNotifiedAt?: string;
  updatedAt: string;
}

export interface Approval extends Owned {
  proposalId: string;
  runId: string;
  decision: 'approved' | 'rejected';
  editedInput?: Record<string, unknown>;
  alwaysAllow: boolean;
  decidedBy: 'owner' | 'policy';
  note?: string;
}

export interface ToolExecution extends Owned {
  proposalId: string;
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'started' | 'executed' | 'verified' | 'verification_failed' | 'failed' | 'undone';
  attempt: number;
  output?: Record<string, unknown>;
  summary?: string;
  /** True when the tool can reverse this execution. Undo is only ever started by the owner. */
  undoable?: boolean;
  undoneAt?: string;
  verification?: { ok: boolean; detail: string };
  error?: { code: string; message: string; action: string };
  finishedAt?: string;
  updatedAt: string;
}

export type MemoryType =
  | 'important_person'
  | 'organization'
  | 'working_hours'
  | 'recurring_commitment'
  | 'communication_preference'
  | 'inbox_rule'
  | 'privacy_restriction'
  | 'approved_automation';

export interface Memory extends Owned {
  type: MemoryType;
  /** Plain-language rule, for example: Messages from person@example.com are high priority. */
  statement: string;
  params: Record<string, string | number | boolean | string[]>;
  source: { kind: 'owner' | 'feedback' | 'agent'; ref?: string; label?: string };
  enabled: boolean;
  /** Local-only memories are never included in any external AI prompt. */
  localOnly: boolean;
  updatedAt: string;
}

export interface AgentSettings extends Owned {
  paused: boolean;
  pausedAt?: string;
  /** Owner's Gmail access choice. Drafts need Google's compose scope; sending stays unavailable. */
  gmailAccess: 'read' | 'drafts';
  /** Owner kill switch for all automations (separate from pausing the whole agent). */
  automationsKilled: boolean;
  timezone: string;
  channels: {
    browser: boolean;
    email: boolean;
    telegram: { enabled: boolean; chatId?: string };
  };
  updatedAt: string;
}

export interface Commitment extends Owned {
  /** `i_owe`: the owner promised or was asked. `they_owe`: someone else owes the owner. */
  direction: 'i_owe' | 'they_owe';
  otherPerson: string;
  otherEmail?: string;
  action: string;
  status: 'open' | 'resolved' | 'snoozed' | 'dismissed';
  expectedAt?: string;
  followUpAt?: string;
  lastFollowUpAt?: string;
  evidenceSignalId?: string;
  /** Short excerpt (at most 200 characters) explaining why Orbit created this. */
  evidence?: string;
  threadId?: string;
  resolutionSignalId?: string;
  resolvedAt?: string;
  reminderId?: string;
  followUpCount?: number;
  confidence: number;
  updatedAt: string;
}

export interface Reminder extends Owned {
  title: string;
  remindAt: string;
  status: 'scheduled' | 'fired' | 'dismissed';
  taskId?: string;
  signalId?: string;
  commitmentId?: string;
  firedAt?: string;
}

export interface OrbitNotification extends Owned {
  title: string;
  body: string;
  kind: 'reminder' | 'digest' | 'alert' | 'failure' | 'info';
  read: boolean;
  runId?: string;
  link?: string;
}
