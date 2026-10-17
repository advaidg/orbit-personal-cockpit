import { z } from 'zod';
import { ActionableError } from '../../diagnostics.js';
import { replySubject } from '../../mime.js';
import { getSignal } from '../../store.js';
import { displayName, extractEmail, id } from './util.js';
import { registerTool, type AnyTool } from './registry.js';
import type { MessageHeaders } from '../services.js';

/**
 * Gmail draft creation. Orbit never sends mail: there is no send tool and the Gmail gateway has no send
 * method. The recipient is always derived from the provider's own message headers, never from model output.
 */
const draftReply: AnyTool = {
  name: 'draft_reply',
  description: 'Create a reply or follow-up draft in Gmail. The draft is never sent.',
  risk: 'draft',
  schema: z.object({
    signalId: id,
    body: z.string().trim().min(1).max(5000),
    subject: z.string().trim().max(200).optional(),
    kind: z.enum(['reply', 'follow_up']).default('reply'),
    round: z.number().int().min(1).max(20).default(1)
  }),
  authorize: async (input, ctx) => {
    const signal = await getSignal(ctx.userId, input.signalId);
    if (!signal || signal.source !== 'gmail') throw new ActionableError('That message is not an email Orbit can reply to.', { action: 'Choose an email from Gmail.', code: 'not_email' });
    const capability = await ctx.services.gmail.capabilities(ctx.userId, signal.metadata?.connectionId as string | undefined);
    if (!capability.connected) throw new ActionableError('Gmail is not connected.', { action: 'Connect Gmail in Connections.', code: 'gmail_disconnected' });
    if (!capability.canDraft) throw new ActionableError('Gmail draft permission is not enabled.', { action: 'Open Connections, choose “Read plus create drafts”, and approve the Google consent screen.', code: 'gmail_scope' });
  },
  preview: async (input, ctx) => {
    const signal = await getSignal(ctx.userId, input.signalId);
    const person = displayName(String(signal?.metadata?.direction === 'outbound' ? signal?.metadata?.toRaw ?? signal?.sender : signal?.sender));
    const excerpt = input.body.length > 220 ? `${input.body.slice(0, 220)}…` : input.body;
    return {
      title: `${input.kind === 'follow_up' ? 'Draft a follow-up to' : 'Draft a reply to'} ${person}`,
      description: `Re: ${signal?.title ?? 'message'}\n\n${excerpt}`,
      dataLeaving: ['The draft subject and text are saved to your Gmail account. Nothing is sent to anyone.'],
      services: ['Gmail (draft only)'],
      editable: ['body', 'subject']
    };
  },
  dedupeKey: (input) => `signal:${input.signalId}:${input.kind}:${input.round}`,
  senderEmail: async (input, ctx) => {
    const signal = await getSignal(ctx.userId, input.signalId);
    return typeof signal?.metadata?.fromAddress === 'string' ? signal.metadata.fromAddress : extractEmail(signal?.sender);
  },
  execute: async (input, ctx) => {
    const signal = await getSignal(ctx.userId, input.signalId);
    if (!signal) throw new ActionableError('That message is no longer in Orbit.', { action: 'Sync again.', code: 'signal_missing' });
    const gmail = ctx.services.gmail;
    const connectionId = signal.metadata?.connectionId as string | undefined;
    const capability = await gmail.capabilities(ctx.userId, connectionId);
    if (!capability.canDraft) throw new ActionableError('Gmail draft permission is not enabled.', { action: 'Choose “Read plus create drafts” in Connections.', code: 'gmail_scope' });

    const headers: MessageHeaders = await gmail.getMessageHeaders(ctx.userId, capability.connectionId ?? connectionId, signal.sourceId);
    const outbound = signal.metadata?.direction === 'outbound';
    const recipient = extractEmail(outbound ? headers.to : headers.replyTo || headers.from);
    if (!recipient) throw new ActionableError('Orbit could not find who to address this draft to.', { action: 'Open the email in Gmail and reply there.', code: 'no_recipient' });
    if (capability.accountEmail && recipient === capability.accountEmail.toLowerCase()) throw new ActionableError('This draft would be addressed to your own account.', { action: 'Open the email in Gmail and reply there.', code: 'self_recipient' });

    const subject = input.subject || replySubject(headers.subject || signal.title);
    const references = [headers.references, headers.messageIdHeader].filter(Boolean).join(' ') || undefined;
    const adopted = ctx.recovering ? await gmail.findDraftByKey?.(ctx.userId, capability.connectionId ?? connectionId, ctx.idempotencyKey) : null;
    const draft = adopted ?? await gmail.createDraft(ctx.userId, capability.connectionId ?? connectionId, { to: recipient, subject, body: input.body, threadId: headers.threadId, inReplyTo: headers.messageIdHeader, references, idempotencyKey: ctx.idempotencyKey });
    return {
      summary: `Created a Gmail draft to ${recipient}. It has not been sent.`,
      output: { draftId: draft.draftId, threadId: draft.threadId ?? headers.threadId ?? null, to: recipient, connectionId: capability.connectionId ?? connectionId ?? null, subject },
      undoable: true
    };
  },
  verify: async (_input, outcome, ctx) => {
    const found = await ctx.services.gmail.getDraft(ctx.userId, (outcome.output.connectionId as string | null) ?? undefined, String(outcome.output.draftId));
    if (!found.exists) return { ok: false, detail: 'Gmail does not show the draft.' };
    if (outcome.output.threadId && found.threadId && found.threadId !== outcome.output.threadId) return { ok: false, detail: 'The draft is not in the original thread.' };
    return { ok: true, detail: 'The draft is in your Gmail Drafts folder.' };
  },
  undo: async (_input, outcome, ctx) => {
    await ctx.services.gmail.deleteDraft(ctx.userId, (outcome.output.connectionId as string | null) ?? undefined, String(outcome.output.draftId));
    return { summary: 'Deleted the draft Orbit created.' };
  }
};

export const gmailTools: AnyTool[] = [draftReply];

export function registerGmailTools(): void {
  for (const tool of gmailTools) registerTool(tool);
}
