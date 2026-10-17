import { decrypt } from './crypto.js';
import { GMAIL_COMPOSE_SCOPE, canDraft, gmailClient, type GoogleTokens } from './gmail.js';
import { ActionableError } from './diagnostics.js';
import { buildRawMessage } from './mime.js';
import { providerLimiter } from './providerLimits.js';
import { getConnections } from './store.js';
import type { GmailGateway, MessageHeaders } from './agent/services.js';
import type { Connection } from './types.js';

async function pickConnection(userId: string, connectionId?: string): Promise<Connection | null> {
  const gmail = (await getConnections(userId)).filter((connection) => connection.provider === 'gmail' && !!connection.encryptedTokens);
  return (connectionId ? gmail.find((connection) => connection.id === connectionId) : undefined) ?? gmail.find((connection) => connection.status === 'connected') ?? gmail[0] ?? null;
}

async function clientFor(userId: string, connectionId?: string, requireDraft = false) {
  const connection = await pickConnection(userId, connectionId);
  if (!connection?.encryptedTokens) throw new ActionableError('Gmail is not connected.', { action: 'Connect Gmail in Connections.', code: 'gmail_disconnected' });
  const tokens = decrypt<GoogleTokens>(connection.encryptedTokens);
  if (requireDraft && !canDraft(tokens)) throw new ActionableError(`Gmail authorization is missing the ${GMAIL_COMPOSE_SCOPE.split('/').pop()} scope.`, { action: 'Open Connections, choose “Read plus create drafts”, and approve the Google consent screen.', code: 'gmail_scope' });
  return { connection, gmail: gmailClient(tokens) };
}

const header = (headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string) => headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
const isNotFound = (error: unknown) => /not found|404|requested entity was not found/i.test(error instanceof Error ? error.message : '');

/**
 * Real Gmail gateway. It deliberately exposes only: read headers, create/get/delete a draft, and find an
 * Orbit draft by key. There is no send method anywhere in this module.
 */
export const gmailGateway: GmailGateway = {
  async capabilities(userId, connectionId) {
    const connection = await pickConnection(userId, connectionId);
    if (!connection?.encryptedTokens) return { connected: false, canDraft: false };
    return { connected: true, canDraft: canDraft(decrypt<GoogleTokens>(connection.encryptedTokens)), connectionId: connection.id, accountEmail: connection.accountEmail };
  },

  async getMessageHeaders(userId, connectionId, messageId): Promise<MessageHeaders> {
    const { gmail } = await clientFor(userId, connectionId);
    const { data } = await providerLimiter.run('gmail', () => gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['From', 'Reply-To', 'To', 'Subject', 'Message-ID', 'References'] }));
    const headers = data.payload?.headers ?? undefined;
    return { threadId: data.threadId ?? undefined, from: header(headers, 'From') ?? '', replyTo: header(headers, 'Reply-To'), to: header(headers, 'To'), subject: header(headers, 'Subject') ?? '', messageIdHeader: header(headers, 'Message-ID'), references: header(headers, 'References') };
  },

  async createDraft(userId, connectionId, draft) {
    const { gmail } = await clientFor(userId, connectionId, true);
    const { data } = await providerLimiter.run('gmail', () => gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: buildRawMessage(draft), threadId: draft.threadId } } }));
    if (!data.id) throw new Error('Gmail did not return a draft id');
    return { draftId: data.id, messageId: data.message?.id ?? undefined, threadId: data.message?.threadId ?? undefined };
  },

  async getDraft(userId, connectionId, draftId) {
    const { gmail } = await clientFor(userId, connectionId);
    try {
      const { data } = await providerLimiter.run('gmail', () => gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'metadata' }));
      const headers = data.message?.payload?.headers ?? undefined;
      return { exists: !!data.id, threadId: data.message?.threadId ?? undefined, to: header(headers, 'To'), subject: header(headers, 'Subject') };
    } catch (error) {
      if (isNotFound(error)) return { exists: false };
      throw error;
    }
  },

  async deleteDraft(userId, connectionId, draftId) {
    const { gmail } = await clientFor(userId, connectionId, true);
    try {
      await providerLimiter.run('gmail', () => gmail.users.drafts.delete({ userId: 'me', id: draftId }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  },

  async findDraftByKey(userId, connectionId, key) {
    const { gmail } = await clientFor(userId, connectionId);
    const { data } = await providerLimiter.run('gmail', () => gmail.users.drafts.list({ userId: 'me', maxResults: 25 }));
    for (const entry of data.drafts ?? []) {
      if (!entry.id) continue;
      const draft = await providerLimiter.run('gmail', () => gmail.users.drafts.get({ userId: 'me', id: entry.id!, format: 'metadata' })).catch(() => null);
      if (header(draft?.data.message?.payload?.headers ?? undefined, 'X-Orbit-Key') === key) return { draftId: entry.id, threadId: draft?.data.message?.threadId ?? undefined };
    }
    return null;
  }
};
