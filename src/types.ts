export type Source = 'gmail' | 'outlook' | 'calendar' | 'github' | 'slack' | 'manual';
export type Priority = 'now' | 'soon' | 'later';
export type AiProvider = 'rules'|'chatgpt-subscription'|'openai'|'anthropic'|'openai-compatible';
export interface Signal { id:string; source:Source; sender:string; title:string; summary:string; occurredAt:string; category:string; priority:Priority; read:boolean; metadata?:Record<string,unknown> }
export interface Task { id:string; title:string; note?:string; dueAt?:string; priority:Priority; status:'open'|'done'|'snoozed'; source:Source }
export interface Connection { id:string; provider:Source; label:string; accountEmail?:string; status:'connected'|'available'|'coming_soon'|'error'; lastSyncedAt?:string;lastSyncAttemptAt?:string; lastSyncError?:string }
export interface ActivityEvent {id:string;type:'sync'|'ai'|'connection'|'settings'|'data'|'agent';status:'info'|'success'|'error';title:string;detail?:string;action?:string;createdAt:string}
export interface Dashboard { user:{name:string;email:string;avatar?:string}; mode:'demo'|'live'; greeting:string; brief:{headline:string;narrative:string;wins:string[];watchouts:string[];generatedAt:string}; signals:Signal[]; tasks:Task[]; connections:Connection[]; settings:{aiProvider:AiProvider;aiInputChars:number;chatgptModel?:string;autoSync:boolean;syncIntervalMinutes:number;syncLookbackDays:number;initialSyncLookbackDays:number;syncMaxMessages:number;initialSyncMaxMessages:number;excludePromotions:boolean;excludeSocial:boolean;excludeForums:boolean;blockedSenders:string[];blockedKeywords:string[]};activity:ActivityEvent[]; system:{storage:'postgres'|'memory';persistent:boolean;passwordLoginConfigured:boolean;passwordRecoveryAvailable:boolean;aiProviders:Array<{id:AiProvider;label:string;configured:boolean;external:boolean}>;chatgpt:{connected:boolean;email?:string;hostId?:string}}; agent:{enabled:boolean;paused:boolean;pendingApprovals:number;openCommitments:number;unreadNotifications:number;timezone:string}; stats:{needsYou:number;waitingOn:number;cleared:number;noiseFiltered:number} }

export type ToolRisk = 'read' | 'local' | 'notify' | 'draft' | 'calendar_write' | 'send' | 'delete' | 'financial' | 'shell' | 'skill_admin' | 'skill_read' | 'skill_write';
export type ProposalStatus = 'pending' | 'approved' | 'executing' | 'executed' | 'failed' | 'rejected' | 'canceled' | 'blocked' | 'previewed';
export interface ProposalPreview { title: string; description: string; dataLeaving: string[]; services: string[]; editable?: string[] }
export interface ActionError { code: string; message: string; action: string }
export interface Proposal {
  id: string; runId: string; toolName: string; risk: ToolRisk; input: Record<string, unknown>; preview: ProposalPreview; reason: string; status: ProposalStatus;
  decidedBy?: 'owner' | 'policy'; policyReason: string; alwaysAllowable: boolean; sourceSignalId?: string; blockedReason?: string; lastError?: ActionError; feedback?: 'helpful' | 'not_helpful';
  generatedBy?: string; createdAt: string; updatedAt: string;
  execution?: { summary?: string; status: string; undoable?: boolean; verification?: { ok: boolean; detail: string } };
}
export interface Approvals { pending: Proposal[]; blocked: Proposal[]; failed: Proposal[]; recent: Proposal[] }
export type RunStatus = 'planning' | 'awaiting_approval' | 'executing' | 'succeeded' | 'failed' | 'canceled';
export interface Run { id: string; objective: string; trigger: { type: string; ref?: string; label?: string }; plan: string[]; provider: string; status: RunStatus; dryRun: boolean; automationId?: string; answer?: string; result?: string; error?: ActionError; startedAt: string; finishedAt?: string; proposalCount?: number }
export interface Step { id: string; index: number; kind: string; title: string; status: string; detail?: string; toolName?: string; proposalId?: string }
export interface Execution { id: string; proposalId: string; toolName: string; status: string; attempt: number; summary?: string; verification?: { ok: boolean; detail: string }; error?: ActionError; undoable?: boolean }
export interface RunDetail { run: Run; steps: Step[]; proposals: Proposal[]; executions: Execution[] }
export interface Commitment { id: string; direction: 'i_owe' | 'they_owe'; otherPerson: string; otherEmail?: string; action: string; status: 'open' | 'resolved' | 'snoozed' | 'dismissed'; expectedAt?: string; followUpAt?: string; evidence?: string; evidenceSignalId?: string; resolvedAt?: string; followUpCount?: number; confidence: number; createdAt: string }
export interface MemoryItem { id: string; type: string; statement: string; params: Record<string, string | number | boolean | string[]>; source: { kind: 'owner' | 'feedback' | 'agent'; ref?: string; label?: string }; enabled: boolean; localOnly: boolean; createdAt: string; updatedAt: string }
export type AutomationAction = { kind: 'create_task'; title: string; priority?: Priority } | { kind: 'draft_reply'; template: 'acknowledge' | 'meeting' | 'follow_up' } | { kind: 'remind'; title?: string; afterHours: number } | { kind: 'notify'; title?: string } | { kind: 'track_commitment'; direction: 'i_owe' | 'they_owe' };
export interface AutomationInput {
  name: string; recipe?: string; enabled: boolean;
  trigger: { type: 'new_email' } | { type: 'schedule'; kind: 'daily' | 'weekly'; at: string; weekday?: number } | { type: 'deadline'; withinHours: number };
  filter: { sender?: string; category?: string; keyword?: string; priority?: Priority; account?: string; importantPeopleOnly?: boolean };
  scope?: 'brief' | 'unresolved' | 'bills_due' | 'waiting_on' | 'no_response';
  actions: AutomationAction[]; approval: 'always_ask' | 'external_only' | 'auto'; dryRun: boolean; maxRunsPerDay: number; notifyOnFailure: boolean;
}
export interface Automation extends AutomationInput { id: string; nextRunAt?: string; lastRunAt?: string; lastRunStatus?: 'ran' | 'no_matches' | 'failed' | 'skipped'; lastRunNote?: string; runCount: number }
export interface Recipe { id: string; name: string; summary: string; trigger: AutomationInput['trigger']; approval: string }
export interface OrbitNotification { id: string; title: string; body: string; kind: string; read: boolean; createdAt: string; link?: string }
export interface JobInfo { id: string; kind: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'; attempts: number; progress?: { phase: string; done?: number; total?: number; message?: string }; result?: Record<string, number>; error?: { message: string; action: string; retryable: boolean }; createdAt: string; finishedAt?: string }
export interface AgentSettings { paused: boolean; gmailAccess: 'read' | 'drafts'; automationsKilled: boolean; timezone: string; channels: { browser: boolean; email: boolean; telegram: { enabled: boolean; chatId?: string } } }
export interface AgentState {
  settings: AgentSettings; pending: number; openCommitments: number;
  limits: { enabled: boolean; maxSteps: number; maxRunsPerDay: number; approvalDefault: 'required' | 'external'; externalWritesEnabled: boolean; emailSendingEnabled: boolean; skillsEnabled: boolean; mcpEnabled: boolean; automationsEnabled: boolean; memoryEnabled: boolean; memoryRetentionDays: number; runRetentionDays: number };
  gmail: { connected: boolean; canDraft: boolean; accountEmail?: string }; calendar: { connected: boolean; canWrite: boolean }; channels: { emailConfigured: boolean; telegramConfigured: boolean };
}
export interface Check { ok: boolean; latencyMs?: number; detail: string; action?: string }
export interface Diagnostics {
  generatedAt: string; database: Check & { storage: 'postgres' | 'memory'; persistent: boolean };
  connections: Array<{ id: string; provider: 'gmail' | 'calendar'; label: string; accountEmail?: string; status: string; lastSyncedAt?: string; lastSyncError?: string; canDraft?: boolean; canWrite?: boolean }>;
  chatgpt: { connected: boolean; email?: string; selected: boolean }; ai: { provider: string; providers: Array<{ id: string; label: string; configured: boolean; external: boolean }> };
  queue: { queued: number; running: number; failed24h: number; succeeded24h: number; recentFailures: Array<{ id: string; kind: string; error?: { message: string; action: string }; at?: string }> };
  scheduler: { lastTickAt: string | null }; agent: { enabled: boolean; paused: boolean; automationsKilled: boolean }; environment: { node: string; production: boolean; smtpConfigured: boolean; telegramConfigured: boolean };
}
export interface SkillInfo { id: string; skillId: string; manifest: { name: string; description: string; version: string; domains: string[]; permissions: { read: string[]; write: string[] }; env: Array<{ name: string; description: string; required: boolean }>; tools: Array<{ name: string; description: string; effect: string }>; mcp?: { url: string } }; checksum: string; verified: boolean; status: 'installed' | 'enabled' | 'disabled'; allowedDomains: string[]; secretsSet: string[]; missingSecrets: string[]; discoveredTools?: Array<{ name: string; description: string; effect: 'read' | 'write' }> }
