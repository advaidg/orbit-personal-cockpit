import express from 'express';
import { RECIPES, automationStore, createAutomation, createFromRecipe, deleteAutomation, getAutomation, listAutomations, runAutomationNow, updateAutomation } from '../agent/automations.js';
import { runStore } from '../agent/stores.js';
import { getAgentSettings } from '../agent/settings.js';
import { agentLimits } from '../agent/config.js';
import { ActionableError } from '../diagnostics.js';
import { handle, ownerId } from './http.js';
import { z } from 'zod';

export const automationsRouter = express.Router();

automationsRouter.get('/', handle(async (_req, res) => {
  const userId = ownerId(res);
  const [automations, settings] = await Promise.all([listAutomations(userId), getAgentSettings(userId)]);
  res.json({ automations, recipes: RECIPES.map(({ id, name, summary, input }) => ({ id, name, summary, trigger: input.trigger, approval: input.approval })), killSwitch: settings.automationsKilled, paused: settings.paused, enabled: agentLimits().automationsEnabled });
}));

automationsRouter.post('/', handle(async (req, res) => {
  const body = z.object({ recipe: z.string().max(60).optional(), enabled: z.boolean().optional() }).passthrough().parse(req.body);
  const automation = body.recipe && !('trigger' in body) ? await createFromRecipe(ownerId(res), body.recipe, body.enabled ?? false) : await createAutomation(ownerId(res), req.body);
  res.status(201).json(automation);
}));

automationsRouter.patch('/:id', handle(async (req, res) => {
  const updated = await updateAutomation(ownerId(res), String(req.params.id), req.body ?? {});
  if (!updated) throw new ActionableError('That automation no longer exists.', { action: 'Refresh Automations.', code: 'not_found' });
  res.json(updated);
}));

automationsRouter.delete('/:id', handle(async (req, res) => {
  if (!(await deleteAutomation(ownerId(res), String(req.params.id)))) throw new ActionableError('That automation no longer exists.', { action: 'Refresh Automations.', code: 'not_found' });
  res.status(204).end();
}));

automationsRouter.post('/:id/run', handle(async (req, res) => {
  const { dryRun } = z.object({ dryRun: z.boolean().optional() }).parse(req.body ?? {});
  res.json(await runAutomationNow(ownerId(res), String(req.params.id), { dryRun }));
}));

automationsRouter.get('/:id/runs', handle(async (req, res) => {
  const userId = ownerId(res);
  const automation = await getAutomation(userId, String(req.params.id));
  if (!automation) throw new ActionableError('That automation no longer exists.', { action: 'Refresh Automations.', code: 'not_found' });
  const runs = (await runStore.list(userId, { limit: 200 })).filter((run) => run.automationId === automation.id).slice(0, 30);
  res.json({ runs });
}));

void automationStore;
