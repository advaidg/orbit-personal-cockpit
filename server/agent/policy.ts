import type { AgentLimits } from './config.js';
import type { Memory, PolicyDecision, ToolRisk } from './types.js';

/** Risk classes the owner may promote to an "always allow" rule. Everything else always asks. */
export const ALWAYS_ALLOWABLE: ReadonlySet<ToolRisk> = new Set<ToolRisk>(['local', 'notify', 'draft', 'skill_read']);

export type AutomationApproval = 'always_ask' | 'external_only' | 'auto';

export interface PolicyInput {
  tool: string;
  risk: ToolRisk;
  limits: AgentLimits;
  paused: boolean;
  /** Owner chose "read + create drafts" for Gmail. */
  draftsEnabled: boolean;
  /** Enabled `approved_automation` memories. */
  rules: Memory[];
  /** Sender the action concerns, so rules can be scoped to one person. */
  senderEmail?: string;
  automationApproval?: AutomationApproval;
}

function ruleApplies(rule: Memory, input: PolicyInput, effect: 'allow' | 'deny'): boolean {
  if (!rule.enabled || rule.type !== 'approved_automation') return false;
  if (rule.params.tool !== input.tool || (rule.params.effect ?? 'allow') !== effect) return false;
  const scoped = typeof rule.params.senderEmail === 'string' ? rule.params.senderEmail.toLowerCase() : '';
  return !scoped || scoped === input.senderEmail?.toLowerCase();
}

const decision = (mode: PolicyDecision['mode'], reason: string, risk: ToolRisk): PolicyDecision => ({ mode, reason, alwaysAllowable: ALWAYS_ALLOWABLE.has(risk) });

const overrideAsk = (input: PolicyInput) => input.automationApproval === 'always_ask';

/**
 * Decides whether a tool call may run automatically, needs the owner's approval, or is forbidden.
 * Pure and exhaustive on purpose: this is the single gate between a model's suggestion and a side effect.
 */
export function decidePolicy(input: PolicyInput): PolicyDecision {
  const { risk, limits } = input;
  if (risk === 'financial') return decision('prohibited', 'Purchases and financial transactions are prohibited.', risk);
  if (risk === 'shell') return decision('prohibited', 'Running arbitrary commands is prohibited in the hosted dashboard.', risk);
  if (risk === 'read') return decision('automatic', 'Reading Orbit’s own stored data is always allowed.', risk);
  if (!limits.enabled) return decision('prohibited', 'The agent is disabled on this installation (AGENT_ENABLED=false).', risk);
  if (input.paused) return decision('prohibited', 'The agent is paused. Resume it to allow actions.', risk);
  if (input.rules.some((rule) => ruleApplies(rule, input, 'deny'))) {
    return decision('prohibited', 'You told Orbit never to do this.', risk);
  }

  if (risk === 'send') {
    if (!limits.emailSendingEnabled) return decision('prohibited', 'Sending email is disabled on this installation (EMAIL_SENDING_ENABLED=false).', risk);
    return decision('ask', 'Sending always needs your approval.', risk);
  }
  if (risk === 'delete') {
    if (!limits.externalWritesEnabled) return decision('prohibited', 'External changes are disabled on this installation (EXTERNAL_WRITES_ENABLED=false).', risk);
    return decision('ask', 'Deleting provider data always needs your approval.', risk);
  }
  if (risk === 'skill_admin') {
    if (!limits.skillsEnabled && !limits.mcpEnabled) return decision('prohibited', 'Skills and MCP are disabled on this installation.', risk);
    return decision('ask', 'Installing or changing skills always needs your approval.', risk);
  }

  if (risk === 'skill_read' || risk === 'skill_write') {
    if (!limits.skillsEnabled && !limits.mcpEnabled) return decision('prohibited', 'Skills and MCP are disabled on this installation.', risk);
    if (risk === 'skill_write' && !limits.externalWritesEnabled) return decision('prohibited', 'External changes are disabled on this installation (EXTERNAL_WRITES_ENABLED=false).', risk);
    if (risk === 'skill_write') return decision('ask', 'A skill that changes an outside service always needs your approval.', risk);
    if (overrideAsk(input)) return decision('ask', 'This automation always asks first.', risk);
    if (input.rules.some((rule) => ruleApplies(rule, input, 'allow'))) return decision('automatic', 'You allowed this skill action to run automatically.', risk);
    return decision('ask', 'Skills send data to an outside service, so Orbit asks first.', risk);
  }

  const isExternal = risk === 'draft' || risk === 'calendar_write' || risk === 'notify';
  const allowed = input.rules.some((rule) => ruleApplies(rule, input, 'allow')) && ALWAYS_ALLOWABLE.has(risk);
  const overrides = input.automationApproval;

  if (isExternal) {
    if (!limits.externalWritesEnabled) return decision('prohibited', 'External changes are disabled on this installation (EXTERNAL_WRITES_ENABLED=false).', risk);
    if (risk === 'draft' && !input.draftsEnabled) return decision('prohibited', 'Gmail draft creation is not enabled. Choose “Read plus create drafts” in Connections.', risk);
    if (overrides === 'always_ask') return decision('ask', 'This automation always asks first.', risk);
    if (overrides === 'auto' && ALWAYS_ALLOWABLE.has(risk)) return decision('automatic', 'This automation is allowed to run automatically.', risk);
    if (allowed) return decision('automatic', 'You allowed this kind of action to run automatically.', risk);
    return decision('ask', 'Changes outside Orbit need your approval.', risk);
  }

  // Orbit-local state changes.
  if (overrides === 'always_ask') return decision('ask', 'This automation always asks first.', risk);
  if (overrides === 'auto' || overrides === 'external_only') return decision('automatic', 'Local changes are automatic for this automation.', risk);
  if (allowed) return decision('automatic', 'You allowed this kind of action to run automatically.', risk);
  if (limits.approvalDefault === 'external') return decision('automatic', 'This installation only asks before changing outside services.', risk);
  return decision('ask', 'This installation asks before every change.', risk);
}
