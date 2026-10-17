import { describe, expect, it } from 'vitest';
import { agentLimits } from '../server/agent/config.js';
import { decidePolicy, ALWAYS_ALLOWABLE, type PolicyInput } from '../server/agent/policy.js';
import type { Memory, ToolRisk } from '../server/agent/types.js';

const limits = agentLimits({});
const base = (risk: ToolRisk, overrides: Partial<PolicyInput> = {}): PolicyInput => ({ tool: 'tool_x', risk, limits, paused: false, draftsEnabled: true, rules: [], ...overrides });
const rule = (params: Memory['params'], enabled = true): Memory => ({ id: 'm', userId: 'u', createdAt: '', updatedAt: '', type: 'approved_automation', statement: '', params, source: { kind: 'owner' }, enabled, localOnly: false });

describe('agent limits', () => {
  it('uses the roadmap defaults', () => {
    expect(limits).toMatchObject({ enabled: true, maxSteps: 12, maxRunsPerDay: 50, approvalDefault: 'required', externalWritesEnabled: true, emailSendingEnabled: false, skillsEnabled: false, mcpEnabled: false, automationsEnabled: true, memoryEnabled: true, memoryRetentionDays: 365, runRetentionDays: 90 });
  });

  it('fails safe on junk values', () => {
    expect(agentLimits({ ACTION_APPROVAL_DEFAULT: 'yolo' }).approvalDefault).toBe('required');
    expect(agentLimits({ AGENT_MAX_STEPS: 'many' }).maxSteps).toBe(12);
    expect(agentLimits({ AGENT_MAX_STEPS: '9999' }).maxSteps).toBe(100);
    expect(agentLimits({ EMAIL_SENDING_ENABLED: 'maybe' }).emailSendingEnabled).toBe(false);
  });
});

describe('approval policy', () => {
  it('always prohibits financial and shell actions, whatever else is configured', () => {
    for (const risk of ['financial', 'shell'] as const) {
      expect(decidePolicy(base(risk, { rules: [rule({ tool: 'tool_x', effect: 'allow' })], automationApproval: 'auto', limits: agentLimits({ ACTION_APPROVAL_DEFAULT: 'external' }) })).mode).toBe('prohibited');
    }
  });

  it('lets reads run automatically', () => {
    expect(decidePolicy(base('read')).mode).toBe('automatic');
  });

  it('asks before local changes by default and allows them when the installation is looser', () => {
    expect(decidePolicy(base('local')).mode).toBe('ask');
    expect(decidePolicy(base('local', { limits: agentLimits({ ACTION_APPROVAL_DEFAULT: 'external' }) })).mode).toBe('automatic');
  });

  it('asks before every external write', () => {
    for (const risk of ['draft', 'calendar_write', 'notify'] as const) expect(decidePolicy(base(risk)).mode).toBe('ask');
  });

  it('never lets "send" or "delete" run without the owner', () => {
    expect(decidePolicy(base('send')).mode).toBe('prohibited');
    const sending = agentLimits({ EMAIL_SENDING_ENABLED: 'true' });
    expect(decidePolicy(base('send', { limits: sending, rules: [rule({ tool: 'tool_x', effect: 'allow' })], automationApproval: 'auto' })).mode).toBe('ask');
    expect(decidePolicy(base('delete', { rules: [rule({ tool: 'tool_x', effect: 'allow' })], automationApproval: 'auto' })).mode).toBe('ask');
    expect(decidePolicy(base('skill_admin', { limits: agentLimits({ SKILLS_ENABLED: 'true' }), rules: [rule({ tool: 'tool_x', effect: 'allow' })] })).mode).toBe('ask');
    expect(decidePolicy(base('skill_admin')).mode).toBe('prohibited');
  });

  it('blocks external writes when the installation disables them', () => {
    const off = agentLimits({ EXTERNAL_WRITES_ENABLED: 'false' });
    for (const risk of ['draft', 'calendar_write', 'notify', 'delete'] as const) expect(decidePolicy(base(risk, { limits: off })).mode).toBe('prohibited');
    expect(decidePolicy(base('local', { limits: off })).mode).toBe('ask');
  });

  it('requires the owner to enable Gmail drafts', () => {
    expect(decidePolicy(base('draft', { draftsEnabled: false })).mode).toBe('prohibited');
  });

  it('stops all writes while paused or disabled but still allows reads', () => {
    for (const risk of ['local', 'draft', 'send', 'delete', 'notify'] as const) {
      expect(decidePolicy(base(risk, { paused: true })).mode).toBe('prohibited');
      expect(decidePolicy(base(risk, { limits: agentLimits({ AGENT_ENABLED: 'false' }) })).mode).toBe('prohibited');
    }
    expect(decidePolicy(base('read', { paused: true })).mode).toBe('automatic');
  });

  it('honours scoped always-allow rules only for allowable risk classes', () => {
    const scoped = rule({ tool: 'tool_x', effect: 'allow', senderEmail: 'maya@example.com' });
    expect(decidePolicy(base('draft', { rules: [scoped], senderEmail: 'MAYA@example.com' })).mode).toBe('automatic');
    expect(decidePolicy(base('draft', { rules: [scoped], senderEmail: 'other@example.com' })).mode).toBe('ask');
    expect(decidePolicy(base('calendar_write', { rules: [rule({ tool: 'tool_x', effect: 'allow' })] })).mode).toBe('ask');
    expect(decidePolicy(base('draft', { rules: [rule({ tool: 'tool_x', effect: 'allow' }, false)] })).mode).toBe('ask');
    expect([...ALWAYS_ALLOWABLE].sort()).toEqual(['draft', 'local', 'notify', 'skill_read']);
  });

  it('lets a "never do this again" rule override everything', () => {
    const deny = rule({ tool: 'tool_x', effect: 'deny' });
    expect(decidePolicy(base('local', { rules: [deny, rule({ tool: 'tool_x', effect: 'allow' })], automationApproval: 'auto' })).mode).toBe('prohibited');
  });

  it('respects per-automation approval modes', () => {
    expect(decidePolicy(base('local', { automationApproval: 'always_ask', rules: [rule({ tool: 'tool_x', effect: 'allow' })] })).mode).toBe('ask');
    expect(decidePolicy(base('local', { automationApproval: 'external_only' })).mode).toBe('automatic');
    expect(decidePolicy(base('draft', { automationApproval: 'external_only' })).mode).toBe('ask');
    expect(decidePolicy(base('draft', { automationApproval: 'auto' })).mode).toBe('automatic');
    expect(decidePolicy(base('calendar_write', { automationApproval: 'auto' })).mode).toBe('ask');
  });
});

describe('skill policy', () => {
  const on = agentLimits({ SKILLS_ENABLED: 'true' });
  it('is prohibited unless skills or MCP are enabled', () => {
    expect(decidePolicy(base('skill_read')).mode).toBe('prohibited');
    expect(decidePolicy(base('skill_write')).mode).toBe('prohibited');
  });
  it('asks before skill reads, allows owner rules, and always asks for skill writes', () => {
    expect(decidePolicy(base('skill_read', { limits: on })).mode).toBe('ask');
    expect(decidePolicy(base('skill_read', { limits: on, rules: [rule({ tool: 'tool_x', effect: 'allow' })] })).mode).toBe('automatic');
    expect(decidePolicy(base('skill_write', { limits: on, rules: [rule({ tool: 'tool_x', effect: 'allow' })], automationApproval: 'auto' })).mode).toBe('ask');
    expect(decidePolicy(base('skill_write', { limits: agentLimits({ SKILLS_ENABLED: 'true', EXTERNAL_WRITES_ENABLED: 'false' }) })).mode).toBe('prohibited');
  });
});
