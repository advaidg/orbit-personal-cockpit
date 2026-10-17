import { z } from 'zod';
import { ActionableError } from '../../diagnostics.js';
import { createPact, pacts } from '../../pacts/service.js';
import { registerTool, type AnyTool } from './registry.js';
import { slug } from './util.js';

const createPactTool: AnyTool = {
  name: 'create_pact',
  description: 'Turn a promise into a pact: a private link the other person can open (no account) to confirm, finish or reschedule it. Nothing is sent; you copy the link yourself.',
  risk: 'local',
  schema: z.object({
    direction: z.enum(['i_owe', 'they_owe']),
    otherPerson: z.string().trim().min(1).max(120),
    otherEmail: z.string().trim().email().max(200).optional(),
    action: z.string().trim().min(1).max(240),
    dueAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Use an ISO date').optional()
  }),
  preview: async (input) => ({
    title: `Make a pact with ${input.otherPerson}`,
    description: `${input.direction === 'they_owe' ? `${input.otherPerson} will` : 'You will'} ${input.action}${input.dueAt ? ` by ${input.dueAt.slice(0, 10)}` : ''}. Orbit creates a private link for you to share. It does not send anything.`,
    dataLeaving: [],
    services: [],
    editable: ['action', 'dueAt']
  }),
  dedupeKey: (input) => `pact:${input.direction}:${slug(input.otherPerson, 24)}:${slug(input.action, 40)}`,
  execute: async (input, ctx) => {
    const { pact, created } = await createPact(ctx.userId, { ...input, dueAt: input.dueAt ? new Date(input.dueAt).toISOString() : undefined }, ctx.now);
    // The link secret is shown only in the pacts screen, at creation. The tool result carries the pact id, never a secret.
    return { summary: created ? `Pact created with ${input.otherPerson}. Open Pacts to copy the link.` : 'That pact already exists.', output: { pactId: pact.id }, undoable: created };
  },
  verify: async (_input, outcome, ctx) => {
    const found = await pacts.get(ctx.userId, String(outcome.output.pactId));
    return { ok: !!found, detail: found ? 'The pact is saved.' : 'The pact was not found after saving.' };
  },
  undo: async (_input, outcome, ctx) => {
    const pact = await pacts.get(ctx.userId, String(outcome.output.pactId));
    if (!pact) throw new ActionableError('That pact is already gone.', { action: 'Nothing to undo.' });
    await pacts.delete(ctx.userId, pact.id);
    return { summary: 'Pact removed. Its link no longer works.' };
  }
};

export function registerPactTools(): void {
  registerTool(createPactTool);
}
