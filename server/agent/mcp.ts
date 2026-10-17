import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { decrypt } from '../crypto.js';
import { ActionableError } from '../diagnostics.js';
import { assertAllowedUrl, safeFetchFor } from '../net.js';
import { providerLimiter } from '../providerLimits.js';
import { agentLimits } from './config.js';
import { skillStore, getSkill, type DiscoveredTool, type SkillRecord } from './skills.js';
import type { AnyTool } from './tools/registry.js';
import { slug } from './tools/util.js';

type JsonSchemaLite = { type?: string; properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };

/** Minimal validator for MCP tool arguments: object shape, required keys, primitive types and enums. */
export function validateArguments(schema: Record<string, unknown>, value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Arguments must be an object';
  const lite = schema as JsonSchemaLite;
  const record = value as Record<string, unknown>;
  for (const key of lite.required ?? []) if (record[key] === undefined) return `Missing required argument: ${key}`;
  for (const [key, entry] of Object.entries(record)) {
    const rule = lite.properties?.[key];
    if (!rule) return `Unexpected argument: ${key}`;
    if (rule.type === 'string' && typeof entry !== 'string') return `${key} must be a string`;
    if (rule.type === 'number' && typeof entry !== 'number') return `${key} must be a number`;
    if (rule.type === 'integer' && !Number.isInteger(entry)) return `${key} must be an integer`;
    if (rule.type === 'boolean' && typeof entry !== 'boolean') return `${key} must be true or false`;
    if (rule.enum && !rule.enum.includes(entry)) return `${key} must be one of the allowed values`;
    if (typeof entry === 'string' && entry.length > 5000) return `${key} is too long`;
  }
  return null;
}

type Connector = (skill: SkillRecord) => Promise<Client>;
let connectorOverride: Connector | null = null;
/** Test seam: lets tests connect to an in-process MCP server instead of a network address. */
export function setMcpConnectorForTests(connector: Connector | null): void {
  connectorOverride = connector;
}

async function connect(skill: SkillRecord): Promise<Client> {
  const limits = agentLimits();
  if (!limits.mcpEnabled) throw new ActionableError('MCP servers are disabled on this installation.', { action: 'Set MCP_ENABLED=true.', code: 'mcp_disabled' });
  if (!skill.manifest.mcp) throw new ActionableError('This skill is not an MCP server.', { action: 'Nothing to connect.' });
  if (connectorOverride) return connectorOverride(skill);
  const url = assertAllowedUrl(skill.manifest.mcp.url, skill.allowedDomains);
  const secrets = skill.encryptedSecrets ? decrypt<Record<string, string>>(skill.encryptedSecrets) : {};
  const token = secrets.MCP_TOKEN;
  const client = new Client({ name: 'orbit', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url, { fetch: safeFetchFor(skill.allowedDomains), requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } });
  await client.connect(transport);
  return client;
}

/** Owner-initiated, read-only `tools/list`. Every discovered tool defaults to "changes something" (always asks). */
export async function discoverMcpTools(userId: string, skillId: string): Promise<DiscoveredTool[]> {
  const skill = await getSkill(userId, skillId);
  if (!skill) throw new ActionableError('That MCP server is not installed.', { action: 'Install it first.' });
  const client = await providerLimiter.run('mcp', () => connect(skill));
  try {
    const listed = await client.listTools();
    const previous = new Map((skill.discoveredTools ?? []).map((tool) => [tool.name, tool.effect]));
    const tools: DiscoveredTool[] = listed.tools.slice(0, 50).map((tool) => ({
      name: tool.name.slice(0, 60), description: (tool.description ?? '').slice(0, 300), inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>, effect: previous.get(tool.name) ?? 'write'
    }));
    await skillStore.update(userId, skill.id, { discoveredTools: tools, updatedAt: new Date().toISOString() });
    return tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** The owner may mark a discovered tool read-only. Server-provided hints are never trusted for this. */
export async function setMcpToolEffect(userId: string, skillId: string, toolName: string, effect: 'read' | 'write'): Promise<SkillRecord | null> {
  const skill = await getSkill(userId, skillId);
  if (!skill?.discoveredTools) return null;
  return skillStore.update(userId, skill.id, { discoveredTools: skill.discoveredTools.map((tool) => (tool.name === toolName ? { ...tool, effect } : tool)), updatedAt: new Date().toISOString() });
}

/** Wraps each discovered MCP tool in Orbit's approval layer. */
export function mcpTools(skill: SkillRecord): AnyTool[] {
  return (skill.discoveredTools ?? []).map((tool) => ({
    name: `skill.${skill.skillId}.${tool.name}`,
    description: `[MCP: ${skill.manifest.name}] ${tool.description}`,
    risk: tool.effect === 'read' ? 'skill_read' : 'skill_write',
    schema: z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
      const problem = validateArguments(tool.inputSchema, value);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
    authorize: async (_input: unknown, ctx: { userId: string }) => {
      const current = await getSkill(ctx.userId, skill.skillId);
      if (!current || current.status !== 'enabled') throw new ActionableError('This MCP server is not enabled.', { action: 'Enable it in Skills first.', code: 'skill_disabled' });
    },
    preview: async (input: Record<string, unknown>) => {
      const host = new URL(skill.manifest.mcp!.url).hostname;
      return { title: `${skill.manifest.name}: ${tool.name}`, description: `${tool.description}\nSent: ${JSON.stringify(input).slice(0, 300)}`, dataLeaving: [`The values above are sent to the MCP server at ${host}.`], services: [host], editable: Object.keys(input) };
    },
    dedupeKey: (input: Record<string, unknown>, ctx: { runId: string }) => `mcp:${skill.skillId}:${tool.name}:${slug(JSON.stringify(input), 60)}:${ctx.runId}`,
    execute: async (input: Record<string, unknown>, ctx: { userId: string }) => {
      const current = await getSkill(ctx.userId, skill.skillId);
      if (!current || current.status !== 'enabled') throw new ActionableError('This MCP server is not enabled.', { action: 'Enable it in Skills first.' });
      const client = await providerLimiter.run('mcp', () => connect(current));
      try {
        const result = await client.callTool({ name: tool.name, arguments: input });
        const text = Array.isArray(result.content) ? result.content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('\n') : '';
        if (result.isError) throw new ActionableError(`The MCP server reported an error: ${text.slice(0, 200)}`, { action: 'Review the arguments and the server.', code: 'mcp_error' });
        return { summary: `${skill.manifest.name} ${tool.name} completed.`, output: { response: text.slice(0, 4000) } };
      } finally {
        await client.close().catch(() => undefined);
      }
    }
  }));
}
