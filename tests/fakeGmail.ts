import type { GmailGateway } from '../server/agent/services.js';

export interface FakeDraft { id: string; to: string; subject: string; body: string; threadId?: string; inReplyTo?: string; key?: string }

/** In-memory Gmail sandbox. It has no way to send, mirroring the real gateway. */
export function createFakeGmail(options: { canDraft?: boolean; accountEmail?: string; headers?: Record<string, { from: string; replyTo?: string; to?: string; subject: string; threadId?: string; messageIdHeader?: string; references?: string }> } = {}) {
  const drafts = new Map<string, FakeDraft>();
  const calls = { createDraft: 0, getHeaders: 0 };
  let counter = 0;
  const state = { canDraft: options.canDraft ?? true, failNextCreate: false };
  const gateway: GmailGateway = {
    capabilities: async () => ({ connected: true, canDraft: state.canDraft, connectionId: 'conn-1', accountEmail: options.accountEmail ?? 'owner@example.com' }),
    getMessageHeaders: async (_u, _c, messageId) => {
      calls.getHeaders += 1;
      const found = options.headers?.[messageId];
      if (!found) throw new Error('404 Requested entity was not found.');
      return found;
    },
    createDraft: async (_u, _c, draft) => {
      calls.createDraft += 1;
      if (state.failNextCreate) { state.failNextCreate = false; throw new Error('ECONNRESET talking to gmail'); }
      counter += 1;
      const id = `draft-${counter}`;
      drafts.set(id, { id, to: draft.to, subject: draft.subject, body: draft.body, threadId: draft.threadId, inReplyTo: draft.inReplyTo, key: draft.idempotencyKey });
      return { draftId: id, threadId: draft.threadId };
    },
    getDraft: async (_u, _c, draftId) => { const d = drafts.get(draftId); return d ? { exists: true, threadId: d.threadId, to: d.to, subject: d.subject } : { exists: false }; },
    deleteDraft: async (_u, _c, draftId) => { drafts.delete(draftId); },
    findDraftByKey: async (_u, _c, key) => { const d = [...drafts.values()].find((item) => item.key === key); return d ? { draftId: d.id, threadId: d.threadId } : null; }
  };
  return { gateway, drafts, calls, state };
}
