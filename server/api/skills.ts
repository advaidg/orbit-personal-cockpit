import express from 'express';
import { z } from 'zod';
import { agentLimits } from '../agent/config.js';
import { discoverMcpTools, setMcpToolEffect } from '../agent/mcp.js';
import { proposeCalls } from '../agent/proposals.js';
import { startRun } from '../agent/runs.js';
import { deleteSkill, disableSkill, getSkill, listSkills, publicSkill, setAllowedDomains, setSecrets } from '../agent/skills.js';
import { ActionableError } from '../diagnostics.js';
import { handle, ownerId } from './http.js';

export const skillsRouter = express.Router();

const requireSkillsEnabled: express.RequestHandler = (_req, _res, next) => {
  const limits = agentLimits();
  if (!limits.skillsEnabled && !limits.mcpEnabled) throw new ActionableError('Skills are disabled on this installation.', { action: 'Set SKILLS_ENABLED=true (and MCP_ENABLED=true for MCP servers) and redeploy.', code: 'skills_disabled' });
  next();
};

skillsRouter.get('/', handle(async (_req, res) => {
  const limits = agentLimits();
  res.json({ enabled: limits.skillsEnabled, mcpEnabled: limits.mcpEnabled, skills: limits.skillsEnabled || limits.mcpEnabled ? (await listSkills(ownerId(res))).map(publicSkill) : [] });
}));

/** Installing is always a proposal: the owner reviews permissions, domains, secrets and checksum first. */
skillsRouter.post('/install', requireSkillsEnabled, handle(async (req, res) => {
  const body = z.object({ manifest: z.unknown(), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }).parse(req.body);
  const userId = ownerId(res);
  const run = await startRun(userId, { objective: 'Install a skill', trigger: { type: 'manual', label: 'Install skill' }, plan: ['Check the manifest and checksum.', 'Show permissions and domains for your review.', 'Install it disabled after you approve.'] });
  const result = await proposeCalls(userId, run, [{ tool: 'install_skill', input: body, reason: 'You asked to install this skill.' }]);
  res.status(201).json({ run, proposals: result.proposals, rejected: result.rejected });
}));

skillsRouter.post('/:id/enable', requireSkillsEnabled, handle(async (req, res) => {
  const { acknowledgeUnverified } = z.object({ acknowledgeUnverified: z.boolean().optional() }).parse(req.body ?? {});
  const userId = ownerId(res);
  const run = await startRun(userId, { objective: `Enable skill ${req.params.id}`, trigger: { type: 'manual', label: 'Enable skill' }, plan: ['Review the tools, domains and secrets.', 'Enable after you approve.'] });
  const result = await proposeCalls(userId, run, [{ tool: 'enable_skill', input: { skillId: String(req.params.id), acknowledgeUnverified: !!acknowledgeUnverified }, reason: 'You asked to enable this skill.' }]);
  res.status(201).json({ run, proposals: result.proposals, rejected: result.rejected });
}));

skillsRouter.put('/:id/secrets', requireSkillsEnabled, handle(async (req, res) => {
  const body = z.object({ secrets: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/), z.string().max(2000)) }).parse(req.body);
  res.json({ secretsSet: await setSecrets(ownerId(res), String(req.params.id), body.secrets) });
}));

skillsRouter.patch('/:id/domains', requireSkillsEnabled, handle(async (req, res) => {
  const { domains } = z.object({ domains: z.array(z.string().max(253)).max(10) }).parse(req.body);
  const skill = await setAllowedDomains(ownerId(res), String(req.params.id), domains);
  if (!skill) throw new ActionableError('That skill is not installed.', { code: 'not_found' });
  res.json(publicSkill(skill));
}));

skillsRouter.post('/:id/discover', requireSkillsEnabled, handle(async (req, res) => res.json({ tools: await discoverMcpTools(ownerId(res), String(req.params.id)) })));

skillsRouter.patch('/:id/tools/:tool', requireSkillsEnabled, handle(async (req, res) => {
  const { effect } = z.object({ effect: z.enum(['read', 'write']) }).parse(req.body);
  const skill = await setMcpToolEffect(ownerId(res), String(req.params.id), String(req.params.tool), effect);
  if (!skill) throw new ActionableError('That tool was not found. Discover the server’s tools first.', { code: 'not_found' });
  res.json(publicSkill(skill));
}));

/** One-click disable and credential deletion are stricter than before, so they need no approval. */
skillsRouter.post('/:id/disable', handle(async (req, res) => {
  const skill = await disableSkill(ownerId(res), String(req.params.id));
  if (!skill) throw new ActionableError('That skill is not installed.', { code: 'not_found' });
  res.json(publicSkill(skill));
}));

skillsRouter.delete('/:id', handle(async (req, res) => {
  if (!(await deleteSkill(ownerId(res), String(req.params.id)))) throw new ActionableError('That skill is not installed.', { code: 'not_found' });
  res.status(204).end();
}));

void getSkill;
