import { z } from 'zod';
import { ActionableError } from '../../diagnostics.js';
import { slug } from './util.js';
import { registerTool, type AnyTool } from './registry.js';

const CHANNELS = ['in_app', 'browser', 'email', 'telegram'] as const;

const notifyOwner: AnyTool = {
  name: 'notify_owner',
  description: 'Send a message to the owner’s own channels: in-app, browser, email digest or Telegram.',
  risk: 'notify',
  /** A notification that stays inside Orbit is a local change; email and Telegram leave the installation. */
  riskFor: (input) => (input.channels.every((channel: string) => channel === 'in_app' || channel === 'browser') ? 'local' : 'notify'),
  schema: z.object({
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(3000),
    channels: z.array(z.enum(CHANNELS)).min(1).max(4).default(['in_app']),
    kind: z.enum(['reminder', 'digest', 'alert', 'failure', 'info']).default('info'),
    link: z.string().max(200).optional(),
    dedupe: z.string().max(120).optional()
  }),
  preview: async (input) => {
    const external = input.channels.filter((channel: string) => channel === 'email' || channel === 'telegram');
    return {
      title: `Notify you: ${input.title}`,
      description: input.body.slice(0, 280),
      dataLeaving: external.map((channel: string) => (channel === 'email' ? 'The title and text are sent by email to you through your SMTP provider.' : 'The title and text are sent to your Telegram chat through Telegram.')),
      services: external.map((channel: string) => (channel === 'email' ? 'Email (SMTP)' : 'Telegram')),
      editable: ['title', 'body']
    };
  },
  dedupeKey: (input, ctx) => `notify:${input.dedupe ?? `${ctx.runId}:${slug(input.title)}`}`,
  execute: async (input, ctx) => {
    const results = await ctx.services.notifier.deliver(ctx.userId, { title: input.title, body: input.body, kind: input.kind, runId: ctx.runId, link: input.link }, input.channels);
    const delivered = results.filter((result) => result.ok);
    if (!delivered.length) throw new ActionableError(`Nothing was delivered. ${results.map((result) => `${result.channel}: ${result.detail}`).join(' ')}`.trim(), { action: 'Check the channel settings in Connections.', retryable: results.some((result) => /network|fetch|ECONN|5\d\d/i.test(result.detail)), code: 'notify_failed' });
    return { summary: `Delivered to ${delivered.map((result) => result.channel).join(', ')}.`, output: { results } };
  },
  verify: async (_input, outcome) => ({ ok: (outcome.output.results as Array<{ ok: boolean }>).some((result) => result.ok), detail: 'At least one channel accepted the message.' })
};

export const notifyTools: AnyTool[] = [notifyOwner];

export function registerNotifyTools(): void {
  for (const tool of notifyTools) registerTool(tool);
}
