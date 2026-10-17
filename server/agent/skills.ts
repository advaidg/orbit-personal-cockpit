import crypto from 'node:crypto';
import { z } from 'zod';
import { Collection, type Owned } from '../collection.js';
import { decrypt, encrypt } from '../crypto.js';
import { ActionableError, redact } from '../diagnostics.js';
import { assertAllowedUrl, safeFetchText } from '../net.js';
import { providerLimiter } from '../providerLimits.js';
import { agentLimits } from './config.js';
import { registerTool, unregisterTool, type AnyTool } from './tools/registry.js';
import { slug } from './tools/util.js';

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,40}$/;
const PARAM_TYPES = ['string', 'number', 'boolean'] as const;

const paramSchema = z.object({
  type: z.enum(PARAM_TYPES),
  description: z.string().max(200),
  required: z.boolean().default(true),
  enum: z.array(z.string().max(80)).max(30).optional(),
  maxLength: z.number().int().min(1).max(5000).default(500)
});

const toolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  description: z.string().min(1).max(300),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  /** https URL; `{param}` placeholders are filled from declared params and URL-encoded. */
  url: z.string().max(500),
  params: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), paramSchema).default({}),
  /** Header values may reference declared secrets as `{{env.NAME}}`. */
  headers: z.record(z.string().max(60), z.string().max(300)).default({}),
  effect: z.enum(['read', 'write', 'delete']).default('read')
});

export const skillManifest = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  author: z.string().max(120).optional(),
  /** Secret names the skill needs. Values are entered by the owner and stored encrypted. */
  env: z.array(z.object({ name: z.string().regex(ENV_NAME), description: z.string().max(200), required: z.boolean().default(true) })).max(10).default([]),
  permissions: z.object({ read: z.array(z.string().max(160)).max(10).default([]), write: z.array(z.string().max(160)).max(10).default([]) }).default({ read: [], write: [] }),
  /** Every external host the skill may contact. No wildcards. */
  domains: z.array(z.string().regex(HOST)).min(1).max(10),
  tools: z.array(toolSchema).max(20).default([]),
  /** Set for remote MCP servers: tools are discovered from the server instead of declared here. */
  mcp: z.object({ url: z.string().max(500) }).optional()
}).superRefine((manifest, ctx) => {
  for (const tool of manifest.tools) {
    const referenced = [...tool.url.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    for (const name of referenced) if (!tool.params[name]) ctx.addIssue({ code: 'custom', message: `Tool ${tool.name} uses {${name}} in its URL but does not declare it as a parameter` });
    try {
      const host = new URL(tool.url.replace(/\{\w+\}/g, 'x')).hostname;
      if (!manifest.domains.includes(host)) ctx.addIssue({ code: 'custom', message: `Tool ${tool.name} contacts ${host}, which is not listed in domains` });
    } catch {
      ctx.addIssue({ code: 'custom', message: `Tool ${tool.name} has an invalid URL` });
    }
    for (const value of Object.values(tool.headers)) for (const match of value.matchAll(/\{\{env\.(\w+)\}\}/g)) if (!manifest.env.some((entry) => entry.name === match[1])) ctx.addIssue({ code: 'custom', message: `Tool ${tool.name} references undeclared secret ${match[1]}` });
  }
  if (manifest.mcp) {
    try {
      if (!manifest.domains.includes(new URL(manifest.mcp.url).hostname)) ctx.addIssue({ code: 'custom', message: 'The MCP server host must be listed in domains' });
    } catch {
      ctx.addIssue({ code: 'custom', message: 'The MCP server URL is invalid' });
    }
  }
});

export type SkillManifest = z.infer<typeof skillManifest>;
export type SkillTool = SkillManifest['tools'][number];

export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Owner-set. MCP annotations are untrusted hints and are never used to relax approvals. */
  effect: 'read' | 'write';
}

export interface SkillRecord extends Owned {
  skillId: string;
  manifest: SkillManifest;
  checksum: string;
  /** True when the installer supplied a SHA-256 that matched the manifest. */
  verified: boolean;
  status: 'installed' | 'enabled' | 'disabled';
  /** Hosts the owner approved. A subset of manifest.domains. */
  allowedDomains: string[];
  encryptedSecrets?: string;
  discoveredTools?: DiscoveredTool[];
  enabledAt?: string;
  updatedAt: string;
}

export const skillStore = new Collection<SkillRecord>('skills');

/** Canonical form so the same manifest always hashes the same, regardless of key order. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

export const manifestChecksum = (manifest: unknown): string => crypto.createHash('sha256').update(canonicalize(manifest)).digest('hex');

export function parseManifest(raw: unknown, expectedSha256?: string): { manifest: SkillManifest; checksum: string; verified: boolean } {
  const parsed = skillManifest.safeParse(raw);
  if (!parsed.success) throw new ActionableError(`The skill manifest is not valid: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`).join('; ')}`, { action: 'Fix the manifest and try again.', code: 'bad_manifest' });
  const checksum = manifestChecksum(parsed.data);
  if (expectedSha256 && expectedSha256.toLowerCase() !== checksum) throw new ActionableError('The manifest does not match the checksum you provided. It may have been altered.', { action: 'Obtain the package again from its publisher.', code: 'checksum_mismatch' });
  return { manifest: parsed.data, checksum, verified: !!expectedSha256 };
}

export async function installSkill(userId: string, manifest: SkillManifest, checksum: string, verified: boolean): Promise<SkillRecord> {
  if (manifest.mcp && !agentLimits().mcpEnabled) throw new ActionableError('MCP servers are disabled on this installation.', { action: 'Set MCP_ENABLED=true to allow them.', code: 'mcp_disabled' });
  if (!manifest.mcp && !agentLimits().skillsEnabled) throw new ActionableError('Skills are disabled on this installation.', { action: 'Set SKILLS_ENABLED=true to allow them.', code: 'skills_disabled' });
  const now = new Date().toISOString();
  const record: SkillRecord = { id: crypto.randomUUID(), userId, createdAt: now, updatedAt: now, skillId: manifest.id, manifest, checksum, verified, status: 'installed', allowedDomains: manifest.domains };
  const existing = await skillStore.findByUniqueKey(userId, manifest.id);
  if (existing) {
    if (existing.status === 'enabled') await disableSkill(userId, existing.skillId);
    return (await skillStore.update(userId, existing.id, { manifest, checksum, verified, status: 'installed', allowedDomains: manifest.domains, discoveredTools: undefined, updatedAt: now })) ?? existing;
  }
  return (await skillStore.insert(record, manifest.id)).item;
}

export const listSkills = (userId: string) => skillStore.list(userId, { order: 'asc' });
export const getSkill = async (userId: string, skillId: string) => skillStore.findByUniqueKey(userId, skillId);

export async function setSecrets(userId: string, skillId: string, secrets: Record<string, string>): Promise<string[]> {
  const skill = await getSkill(userId, skillId);
  if (!skill) throw new ActionableError('That skill is not installed.', { action: 'Install it first.' });
  const declared = new Set(skill.manifest.env.map((entry) => entry.name));
  const current = skill.encryptedSecrets ? decrypt<Record<string, string>>(skill.encryptedSecrets) : {};
  for (const [name, value] of Object.entries(secrets)) {
    if (!declared.has(name)) throw new ActionableError(`${name} is not a secret this skill declared.`, { action: 'Only declared secrets can be stored.' });
    if (value) current[name] = value.slice(0, 2000);
    else delete current[name];
  }
  await skillStore.update(userId, skill.id, { encryptedSecrets: encrypt(current), updatedAt: new Date().toISOString() });
  return Object.keys(current);
}

export const secretNames = (skill: SkillRecord): string[] => (skill.encryptedSecrets ? Object.keys(decrypt<Record<string, string>>(skill.encryptedSecrets)) : []);

function missingSecrets(skill: SkillRecord): string[] {
  const present = new Set(secretNames(skill));
  return skill.manifest.env.filter((entry) => entry.required && !present.has(entry.name)).map((entry) => entry.name);
}

// ---- tool registration -------------------------------------------------------------------------------------

export const skillToolName = (skillId: string, tool: string) => `skill.${skillId}.${tool}`;

function zodForParams(params: SkillTool['params']): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, def] of Object.entries(params)) {
    let field: z.ZodType = def.type === 'string' ? (def.enum ? z.enum(def.enum as [string, ...string[]]) : z.string().max(def.maxLength)) : def.type === 'number' ? z.number() : z.boolean();
    if (!def.required) field = field.optional();
    shape[name] = field;
  }
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}

function fillTemplate(template: string, values: Record<string, unknown>, encode: boolean): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => (encode ? encodeURIComponent(String(values[key] ?? '')) : String(values[key] ?? '')));
}

export async function runDeclaredTool(userId: string, skillId: string, tool: SkillTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; text: string; truncated: boolean }> {
  const skill = await getSkill(userId, skillId);
  if (!skill || skill.status !== 'enabled') throw new ActionableError('This skill is not enabled.', { action: 'Enable it in Skills first.', code: 'skill_disabled' });
  const url = assertAllowedUrl(fillTemplate(tool.url, input, true), skill.allowedDomains);
  const secrets = skill.encryptedSecrets ? decrypt<Record<string, string>>(skill.encryptedSecrets) : {};
  const headers: Record<string, string> = { 'User-Agent': 'Orbit-Skill/1', Accept: 'application/json, text/plain;q=0.8' };
  for (const [name, value] of Object.entries(tool.headers)) {
    headers[name] = value.replace(/\{\{env\.(\w+)\}\}/g, (_match, key: string) => {
      if (!secrets[key]) throw new ActionableError(`The secret ${key} is not set for this skill.`, { action: 'Add it in Skills.', code: 'secret_missing' });
      return secrets[key];
    });
  }
  const hasBody = tool.method !== 'GET' && tool.method !== 'DELETE';
  if (hasBody) headers['Content-Type'] = 'application/json';
  const response = await providerLimiter.run(`skill:${skillId}`, () => safeFetchText(url, { method: tool.method, headers, body: hasBody ? JSON.stringify(input) : undefined, signal }));
  if (!response.ok) throw new ActionableError(`The service answered ${response.status}.`, { action: response.status === 401 || response.status === 403 ? 'Check the skill’s secret in Skills.' : 'Try again later or review the skill.', retryable: response.status >= 500 || response.status === 429, code: 'skill_http' });
  return { status: response.status, text: redact(response.text, 4000), truncated: response.truncated };
}

const RISK = { read: 'skill_read', write: 'skill_write', delete: 'delete' } as const;

function buildDeclaredTool(skill: SkillRecord, tool: SkillTool): AnyTool {
  const schema = zodForParams(tool.params);
  const host = new URL(tool.url.replace(/\{\w+\}/g, 'x')).hostname;
  return {
    name: skillToolName(skill.skillId, tool.name),
    description: `[skill: ${skill.manifest.name}] ${tool.description}`,
    risk: RISK[tool.effect],
    schema,
    authorize: async (_input, ctx) => {
      const current = await getSkill(ctx.userId, skill.skillId);
      if (!current || current.status !== 'enabled') throw new ActionableError('This skill is not enabled.', { action: 'Enable it in Skills first.', code: 'skill_disabled' });
    },
    preview: async (input) => ({
      title: `${skill.manifest.name}: ${tool.name}`,
      description: `${tool.description}\n${tool.method} ${host}\nSent: ${JSON.stringify(input).slice(0, 300)}`,
      dataLeaving: [`The values above are sent to ${host}.`],
      services: [host],
      editable: Object.keys(tool.params)
    }),
    dedupeKey: (input, ctx) => `skill:${skill.skillId}:${tool.name}:${slug(JSON.stringify(input), 60)}:${ctx.runId}`,
    execute: async (input, ctx) => {
      const result = await runDeclaredTool(ctx.userId, skill.skillId, tool, input, ctx.signal);
      return { summary: `${skill.manifest.name} ${tool.name} answered ${result.status}.`, output: { status: result.status, response: result.text, truncated: result.truncated } };
    }
  };
}

const registered = new Map<string, string[]>();

/** Makes an enabled skill's tools available to the agent. Idempotent. */
export function registerSkillTools(skill: SkillRecord, extra: AnyTool[] = []): void {
  unregisterSkillTools(skill.skillId);
  const tools = [...skill.manifest.tools.map((tool) => buildDeclaredTool(skill, tool)), ...extra];
  for (const tool of tools) registerTool(tool);
  registered.set(skill.skillId, tools.map((tool) => tool.name));
}

export function unregisterSkillTools(skillId: string): void {
  for (const name of registered.get(skillId) ?? []) unregisterTool(name);
  registered.delete(skillId);
}

export async function enableSkill(userId: string, skillId: string, options: { acknowledgeUnverified?: boolean } = {}, buildExtra?: (skill: SkillRecord) => AnyTool[]): Promise<SkillRecord> {
  const skill = await getSkill(userId, skillId);
  if (!skill) throw new ActionableError('That skill is not installed.', { action: 'Install it first.', code: 'not_installed' });
  if (skill.manifest.mcp && !agentLimits().mcpEnabled) throw new ActionableError('MCP servers are disabled on this installation.', { action: 'Set MCP_ENABLED=true.', code: 'mcp_disabled' });
  if (!skill.manifest.mcp && !agentLimits().skillsEnabled) throw new ActionableError('Skills are disabled on this installation.', { action: 'Set SKILLS_ENABLED=true.', code: 'skills_disabled' });
  if (!skill.verified && !options.acknowledgeUnverified) throw new ActionableError('This package was installed without a checksum.', { action: 'Confirm that you trust its source, or reinstall it with the publisher’s SHA-256.', code: 'unverified' });
  const missing = missingSecrets(skill);
  if (missing.length) throw new ActionableError(`Add the required secret${missing.length === 1 ? '' : 's'} first: ${missing.join(', ')}.`, { action: 'Open Skills and enter the missing values.', code: 'secret_missing' });
  if (skill.manifest.mcp && !skill.discoveredTools?.length) throw new ActionableError('Discover the MCP server’s tools before enabling it.', { action: 'Use “Discover tools”, review them, then enable.', code: 'not_discovered' });
  const updated = (await skillStore.update(userId, skill.id, { status: 'enabled', enabledAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))!;
  registerSkillTools(updated, buildExtra?.(updated) ?? []);
  return updated;
}

/** One-click disable. Stricter than before, so it needs no approval. */
export async function disableSkill(userId: string, skillId: string): Promise<SkillRecord | null> {
  const skill = await getSkill(userId, skillId);
  if (!skill) return null;
  unregisterSkillTools(skillId);
  return skillStore.update(userId, skill.id, { status: 'disabled', updatedAt: new Date().toISOString() });
}

/** Removes the skill and every credential stored for it. */
export async function deleteSkill(userId: string, skillId: string): Promise<boolean> {
  const skill = await getSkill(userId, skillId);
  if (!skill) return false;
  unregisterSkillTools(skillId);
  return skillStore.delete(userId, skill.id);
}

export async function setAllowedDomains(userId: string, skillId: string, domains: string[]): Promise<SkillRecord | null> {
  const skill = await getSkill(userId, skillId);
  if (!skill) return null;
  const allowed = domains.filter((domain) => skill.manifest.domains.includes(domain));
  return skillStore.update(userId, skill.id, { allowedDomains: allowed, updatedAt: new Date().toISOString() });
}

/** Never returns secret values. */
export function publicSkill(skill: SkillRecord) {
  const { encryptedSecrets: _secrets, ...rest } = skill;
  return { ...rest, secretsSet: secretNames(skill), missingSecrets: missingSecrets(skill) };
}
