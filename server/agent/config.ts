/**
 * Installation-level ceilings. Environment variables define the maximum the agent may ever do on this
 * installation; the owner's UI settings can only make things stricter, never looser.
 */
export interface AgentLimits {
  enabled: boolean;
  maxSteps: number;
  maxRunsPerDay: number;
  /** `required`: every state-changing action asks first. `external`: only actions that touch outside services ask. */
  approvalDefault: 'required' | 'external';
  externalWritesEnabled: boolean;
  emailSendingEnabled: boolean;
  skillsEnabled: boolean;
  mcpEnabled: boolean;
  automationsEnabled: boolean;
  memoryEnabled: boolean;
  memoryRetentionDays: number;
  runRetentionDays: number;
}

type Env = Record<string, string | undefined>;

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== undefined && value !== '' ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

export function agentLimits(env: Env = process.env): AgentLimits {
  return {
    enabled: flag(env.AGENT_ENABLED, true),
    maxSteps: bounded(env.AGENT_MAX_STEPS, 12, 1, 100),
    maxRunsPerDay: bounded(env.AGENT_MAX_RUNS_PER_DAY, 50, 1, 5000),
    // Anything other than the explicit looser value fails safe to "required".
    approvalDefault: env.ACTION_APPROVAL_DEFAULT?.trim().toLowerCase() === 'external' ? 'external' : 'required',
    externalWritesEnabled: flag(env.EXTERNAL_WRITES_ENABLED, true),
    emailSendingEnabled: flag(env.EMAIL_SENDING_ENABLED, false),
    skillsEnabled: flag(env.SKILLS_ENABLED, false),
    mcpEnabled: flag(env.MCP_ENABLED, false),
    automationsEnabled: flag(env.AUTOMATIONS_ENABLED, true),
    memoryEnabled: flag(env.MEMORY_ENABLED, true),
    memoryRetentionDays: bounded(env.MEMORY_RETENTION_DAYS, 365, 1, 3650),
    runRetentionDays: bounded(env.RUN_RETENTION_DAYS, 90, 1, 3650)
  };
}
