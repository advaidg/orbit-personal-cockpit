import express from 'express';
import { z } from 'zod';
import { ActionableError } from '../diagnostics.js';
import { classify } from '../guard/classify.js';
import { tally, eventsForDay } from '../guard/digest.js';
import { MAX_PENDING_PER_AGENT, resolveRequest } from '../guard/engine.js';
import { validateRuleInput } from '../guard/rules.js';
import { addRule, createAgent, deleteRule, events, getSettings, listAgents, listRules, requests, revokeAgent, saveSettings, updateAgent } from '../guard/store.js';
import { sha256 } from '../guard/summary.js';
import { costOf, dayKey, usageToday, weighted } from '../guard/usage.js';
import { getAgentSettings } from '../agent/settings.js';
import { pactLimits, publicBaseUrl } from '../pacts/config.js';
import { handle, ownerId } from './http.js';

export const guardRouter = express.Router();

const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', '*'] as const;

/** The settings file snippet and the two environment variables an agent needs. The token itself is never in the snippet. */
export function installInstructions(waitSeconds: number) {
  const base = publicBaseUrl();
  const timeout = Math.min(600, waitSeconds + 30);
  return {
    url: base,
    scriptUrl: `${base}/guard/hook.mjs`,
    timeoutSeconds: timeout,
    download: `mkdir -p ~/.orbit && curl -fsSL ${base}/guard/hook.mjs -o ~/.orbit/orbit-guard.mjs`,
    env: [`export ORBIT_URL=${base}`, 'export ORBIT_GUARD_TOKEN=<paste the token>'],
    settings: JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node ~/.orbit/orbit-guard.mjs', timeout }] }] } }, null, 2)
  };
}

const budget = z.number().int().min(10_000).max(5_000_000_000);

guardRouter.get('/', handle(async (_req, res) => {
  const userId = ownerId(res);
  const [settings, agentList, pending, agentSettings] = await Promise.all([getSettings(userId), listAgents(userId), requests.list(userId, { where: { status: 'pending' } }), getAgentSettings(userId)]);
  const day = await dayKey(userId);
  const today = await eventsForDay(userId, day, agentSettings.timezone);
  const withUsage = await Promise.all(agentList.map(async (agent) => {
    const usage = await usageToday(userId, agent.id);
    const cost = await costOf(userId, usage.totals);
    const { tokenHash, ...safe } = agent;
    return { ...safe, usage: { totals: usage.totals, weighted: weighted(usage.totals), costUsd: cost } };
  }));
  res.json({
    settings, agents: withUsage, pending: pending.map(({ subjectHash, cwd, ...rest }) => ({ ...rest, hasCwd: !!cwd })), today: tally(today), day,
    install: installInstructions(settings.waitSeconds), limits: { maxPendingPerAgent: MAX_PENDING_PER_AGENT }, federationReachable: pactLimits().enabled
  });
}));

// ---- agents -----------------------------------------------------------------------------------------------------

guardRouter.post('/agents', handle(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(['claude-code', 'other']).optional(), dailyTokenBudget: budget.optional() }).parse(req.body);
  if ((await listAgents(ownerId(res))).length >= 20) throw new ActionableError('That is a lot of agents.', { action: 'Remove one you no longer use first.', code: 'limit' });
  const { agent, token } = await createAgent(ownerId(res), body);
  const { tokenHash, ...safe } = agent;
  const settings = await getSettings(ownerId(res));
  res.status(201).json({ agent: safe, token, install: installInstructions(settings.waitSeconds) });
}));

guardRouter.patch('/agents/:id', handle(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(60).optional(), paused: z.boolean().optional(), dailyTokenBudget: budget.nullable().optional() }).parse(req.body);
  const agent = await updateAgent(ownerId(res), String(req.params.id), body);
  if (!agent || agent.revokedAt) throw new ActionableError('That agent no longer exists.', { action: 'Refresh Agents.', code: 'not_found' });
  const { tokenHash, ...safe } = agent;
  res.json({ agent: safe });
}));

guardRouter.delete('/agents/:id', handle(async (req, res) => {
  if (!(await revokeAgent(ownerId(res), String(req.params.id)))) throw new ActionableError('That agent no longer exists.', { action: 'Refresh Agents.', code: 'not_found' });
  res.status(204).end();
}));

// ---- requests, events -------------------------------------------------------------------------------------------

guardRouter.get('/requests', handle(async (req, res) => {
  const status = typeof req.query.status === 'string' && ['pending', 'approved', 'denied', 'expired'].includes(req.query.status) ? req.query.status : undefined;
  const list = await requests.list(ownerId(res), { where: status ? { status } : undefined, limit: 50 });
  res.json({ requests: list.map(({ subjectHash, cwd, ...rest }) => ({ ...rest, hasCwd: !!cwd })) });
}));

guardRouter.post('/requests/:id/resolve', handle(async (req, res) => {
  const body = z.object({ decision: z.enum(['approved', 'denied']), remember: z.boolean().optional() }).parse(req.body);
  const done = await resolveRequest(ownerId(res), String(req.params.id), body.decision, { remember: body.remember });
  if (!done) throw new ActionableError('That request was already answered, or it timed out.', { action: 'Nothing to do.', code: 'not_pending' });
  const { subjectHash, cwd, ...safe } = done;
  res.json({ request: safe });
}));

guardRouter.get('/events', handle(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const verdict = typeof req.query.verdict === 'string' && ['allow', 'ask', 'deny', 'defer'].includes(req.query.verdict) ? req.query.verdict : undefined;
  const list = await events.list(ownerId(res), { where: verdict ? { verdict } : undefined, limit });
  res.json({ events: list });
}));

// ---- rules ------------------------------------------------------------------------------------------------------

guardRouter.get('/rules', handle(async (_req, res) => {
  res.json({ rules: (await listRules(ownerId(res))).map(({ valueHash, ...rule }) => ({ ...rule, exactHash: !!valueHash })) });
}));

guardRouter.post('/rules', handle(async (req, res) => {
  const body = z.object({ tool: z.enum(TOOLS), match: z.enum(['exact', 'glob']), value: z.string().trim().min(1).max(300), project: z.string().trim().max(300).optional(), action: z.enum(['allow', 'ask', 'deny']), note: z.string().trim().max(200).optional() }).parse(req.body);
  validateRuleInput(body);
  const { rule, created } = await addRule(ownerId(res), { ...body, valueHash: body.match === 'exact' ? sha256(body.value) : undefined });
  const { valueHash, ...safe } = rule;
  res.status(created ? 201 : 200).json({ rule: safe, created });
}));

guardRouter.delete('/rules/:id', handle(async (req, res) => {
  if (!(await deleteRule(ownerId(res), String(req.params.id)))) throw new ActionableError('That rule no longer exists.', { action: 'Refresh Agents.', code: 'not_found' });
  res.status(204).end();
}));

// ---- settings & playground --------------------------------------------------------------------------------------

const rate = z.number().min(0).max(1000);

guardRouter.put('/settings', handle(async (req, res) => {
  const body = z.object({
    strictness: z.enum(['relaxed', 'balanced', 'strict']).optional(),
    waitSeconds: z.number().int().min(5).max(540).optional(),
    onTimeout: z.enum(['defer', 'deny']).optional(),
    dailyDigest: z.boolean().optional(),
    usdPerMillion: z.object({ input: rate, output: rate, cacheRead: rate, cacheWrite: rate }).nullable().optional()
  }).parse(req.body);
  const settings = await saveSettings(ownerId(res), body);
  res.json({ settings, install: installInstructions(settings.waitSeconds) });
}));

/** "What would Orbit do with this?" Nothing is recorded and nothing runs. */
guardRouter.post('/try', handle(async (req, res) => {
  const body = z.object({ tool: z.enum(TOOLS).default('Bash'), command: z.string().max(4000).optional(), path: z.string().max(1000).optional(), cwd: z.string().max(500).optional() }).parse(req.body);
  const settings = await getSettings(ownerId(res));
  const input: Record<string, unknown> = body.tool === 'Bash' ? { command: body.command ?? '' } : { file_path: body.path ?? '' };
  const tool = body.tool === '*' ? 'Bash' : body.tool;
  const result = classify({ tool, input, cwd: body.cwd || '/home/you/project' }, settings.strictness);
  res.json({ ...result, strictness: settings.strictness });
}));
