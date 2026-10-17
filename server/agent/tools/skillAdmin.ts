import { z } from 'zod';
import { ActionableError } from '../../diagnostics.js';
import { mcpTools } from '../mcp.js';
import { enableSkill, getSkill, installSkill, parseManifest, secretNames, skillManifest } from '../skills.js';
import { registerTool, type AnyTool } from './registry.js';

/** Installing or enabling a skill is the most consequential thing the agent layer can do, so it always asks. */
const installSkillTool: AnyTool = {
  name: 'install_skill',
  description: 'Install a skill or MCP server definition. It is installed disabled.',
  risk: 'skill_admin',
  schema: z.object({ manifest: z.unknown(), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }).superRefine((value, ctx) => {
    const parsed = skillManifest.safeParse(value.manifest);
    if (!parsed.success) for (const issue of parsed.error.issues.slice(0, 3)) ctx.addIssue({ code: 'custom', message: `${issue.path.join('.') || 'manifest'}: ${issue.message}` });
  }),
  preview: async (input) => {
    const { manifest, checksum, verified } = parseManifest(input.manifest, input.sha256);
    return {
      title: `Install ${manifest.mcp ? 'MCP server' : 'skill'} “${manifest.name}” v${manifest.version}`,
      description: [
        manifest.description,
        `Checksum: ${checksum.slice(0, 16)}… ${verified ? '(matches the publisher’s SHA-256)' : '(NOT verified — no publisher checksum was supplied)'}`,
        `Can read: ${manifest.permissions.read.join('; ') || 'nothing declared'}`,
        `Can change: ${manifest.permissions.write.join('; ') || 'nothing declared'}`,
        `Secrets needed: ${manifest.env.map((entry) => entry.name).join(', ') || 'none'}`,
        `Tools: ${manifest.mcp ? 'discovered from the server after install' : manifest.tools.map((tool) => `${tool.name} (${tool.effect})`).join(', ')}`
      ].join('\n'),
      dataLeaving: [`When enabled, data you approve is sent to: ${manifest.domains.join(', ')}.`],
      services: manifest.domains
    };
  },
  dedupeKey: (input) => `install:${parseManifest(input.manifest).checksum}`,
  execute: async (input, ctx) => {
    const { manifest, checksum, verified } = parseManifest(input.manifest, input.sha256);
    const skill = await installSkill(ctx.userId, manifest, checksum, verified);
    return { summary: `Installed “${manifest.name}”. It is disabled until you enable it.`, output: { skillId: skill.skillId, checksum } };
  },
  verify: async (_input, outcome, ctx) => ({ ok: !!(await getSkill(ctx.userId, String(outcome.output.skillId))), detail: 'The skill is installed (disabled).' })
};

const enableSkillTool: AnyTool = {
  name: 'enable_skill',
  description: 'Enable an installed skill so the agent can propose its tools.',
  risk: 'skill_admin',
  schema: z.object({ skillId: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/), acknowledgeUnverified: z.boolean().default(false) }),
  authorize: async (input, ctx) => { if (!(await getSkill(ctx.userId, input.skillId))) throw new ActionableError('That skill is not installed.', { action: 'Install it first.' }); },
  preview: async (input, ctx) => {
    const skill = (await getSkill(ctx.userId, input.skillId))!;
    const tools = skill.manifest.mcp ? (skill.discoveredTools ?? []).map((tool) => `${tool.name} (${tool.effect === 'read' ? 'read' : 'changes things'})`) : skill.manifest.tools.map((tool) => `${tool.name} (${tool.effect})`);
    return {
      title: `Enable “${skill.manifest.name}”`,
      description: [`Tools the agent will be able to propose: ${tools.join(', ') || 'none'}.`, `Approved domains: ${skill.allowedDomains.join(', ')}.`, `Secrets stored: ${secretNames(skill).join(', ') || 'none'}.`, skill.verified ? 'Checksum verified.' : 'Warning: this package was installed without a verified checksum.', 'Every tool call still needs approval (unless you allow a read-only tool).'].join('\n'),
      dataLeaving: [`Approved calls send data to: ${skill.allowedDomains.join(', ')}.`],
      services: skill.allowedDomains
    };
  },
  dedupeKey: (input, ctx) => `enable:${input.skillId}:${ctx.runId}`,
  execute: async (input, ctx) => {
    const skill = await enableSkill(ctx.userId, input.skillId, { acknowledgeUnverified: input.acknowledgeUnverified }, (record) => (record.manifest.mcp ? mcpTools(record) : []));
    return { summary: `Enabled “${skill.manifest.name}”.`, output: { skillId: skill.skillId } };
  },
  verify: async (input, _outcome, ctx) => ({ ok: (await getSkill(ctx.userId, input.skillId))?.status === 'enabled', detail: 'The skill is enabled.' })
};

export const skillAdminTools: AnyTool[] = [installSkillTool, enableSkillTool];

export function registerSkillAdminTools(): void {
  for (const tool of skillAdminTools) registerTool(tool);
}
