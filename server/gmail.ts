import crypto from 'node:crypto';
import { google, gmail_v1 } from 'googleapis';
import { decrypt } from './crypto.js';
import { buildBrief, understandMessages } from './ai.js';
import { ActionableError, diagnose, logSafe } from './diagnostics.js';
import { providerLimiter } from './providerLimits.js';
import type { JobProgress } from './jobs.js';
import { createTask, getConnections, getSettings, getSignals, getSignalSourceIds, logActivity, saveBrief, upsertConnection, upsertSignal } from './store.js';
import { adjustTriage, fromAddressOf, isIgnored, requiresLocalProcessing } from './agent/memoryRules.js';
import { listMemories } from './agent/memory.js';
import { ingestNewMessages, type IngestItem } from './agent/ingest.js';
import type { Connection, Signal } from './types.js';

export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

export type GoogleTokens = { access_token?: string | null; refresh_token?: string | null; scope?: string; token_type?: string | null; expiry_date?: number | null };

export function oauthClient() {
  const base = process.env.APP_URL || 'http://localhost:3000';
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${base}/auth/google/callback`);
}

export const grantedScopes = (tokens: GoogleTokens): string[] => (tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : []);
/** Google has no draft-only scope: compose also permits sending. Orbit's code simply has no send path. */
export const canDraft = (tokens: GoogleTokens): boolean => grantedScopes(tokens).includes(GMAIL_COMPOSE_SCOPE);

export function gmailClient(tokens: GoogleTokens) {
  const auth = oauthClient();
  auth.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth });
}

// ---- message parsing -------------------------------------------------------------------------------------

export interface FetchedMessage {
  id: string;
  threadId?: string;
  from: string;
  replyTo?: string;
  to?: string;
  subject: string;
  date: string;
  rfcId?: string;
  /** Whitespace-collapsed text for classification (capped). */
  text: string;
  /** Newline-preserving text used only in memory for commitment detection; never stored. */
  rawText: string;
  direction: 'inbound' | 'outbound';
}

function decodePart(data?: string | null): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
}

function collect(part: gmail_v1.Schema$MessagePart | undefined, mime: string, out: string[]): void {
  if (!part) return;
  if (part.mimeType === mime && part.body?.data) out.push(decodePart(part.body.data));
  for (const child of part.parts || []) collect(child, mime, out);
}

/** Prefers text/plain parts (avoiding the duplicate HTML alternative) and falls back to converted HTML. */
export function messageText(payload?: gmail_v1.Schema$MessagePart): string {
  const plain: string[] = [];
  collect(payload, 'text/plain', plain);
  if (plain.length) return plain.join('\n');
  const html: string[] = [];
  collect(payload, 'text/html', html);
  if (html.length) return html.map(htmlToText).join('\n');
  return payload?.body?.data ? decodePart(payload.body.data) : '';
}

/** Stable per message, so reprocessing re-creates the same signal id and agent dedupe keys keep matching. */
export function stableSignalId(userId: string, sourceId: string): string {
  return crypto.createHash('sha1').update(`signal:${userId}:gmail:${sourceId}`).digest('hex');
}

function safeDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function parseMessage(data: gmail_v1.Schema$Message, accountEmail?: string): FetchedMessage {
  const headers = Object.fromEntries((data.payload?.headers || []).map((header) => [header.name?.toLowerCase(), header.value])) as Record<string, string | undefined>;
  const internalTime = Number(data.internalDate);
  const rawText = messageText(data.payload).slice(0, 12_000) || data.snippet || '';
  const from = headers.from || 'Unknown sender';
  const outbound = !!accountEmail && fromAddressOf(from) === accountEmail.toLowerCase();
  return {
    id: data.id!, threadId: data.threadId || undefined, from, replyTo: headers['reply-to'], to: headers.to,
    subject: headers.subject || '(no subject)', date: headers.date || (Number.isFinite(internalTime) ? new Date(internalTime).toISOString() : new Date().toISOString()),
    rfcId: headers['message-id'], text: rawText.replace(/\s+/g, ' ').trim().slice(0, 6000), rawText, direction: outbound ? 'outbound' : 'inbound'
  };
}

// ---- sync ------------------------------------------------------------------------------------------------

export interface SyncHooks {
  progress?: (update: JobProgress) => Promise<void> | void;
  throwIfCanceled?: () => Promise<void>;
}

const noop = async () => undefined;

export async function syncGmailConnection(connection: Connection, hooks: SyncHooks = {}) {
  if (!connection.encryptedTokens) return;
  const progress = hooks.progress ?? noop;
  const checkpoint = hooks.throwIfCanceled ?? noop;
  const tokens = decrypt<GoogleTokens>(connection.encryptedTokens);
  if (tokens.scope && !grantedScopes(tokens).includes(GMAIL_READ_SCOPE)) throw new Error('Gmail authorization is missing the gmail.readonly scope');
  const gmail = gmailClient(tokens);
  const settings = await getSettings(connection.userId);
  const initial = !connection.lastSyncedAt;
  const lookbackDays = initial ? settings.initialSyncLookbackDays : settings.syncLookbackDays;
  const maxResults = initial ? settings.initialSyncMaxMessages : settings.syncMaxMessages;
  const exclusions = ['-in:spam', '-in:trash'];
  if (settings.excludePromotions) exclusions.push('-category:promotions');
  if (settings.excludeSocial) exclusions.push('-category:social');
  if (settings.excludeForums) exclusions.push('-category:forums');

  await progress({ phase: 'fetching', message: `Listing recent messages for ${connection.label}` });
  const list = await providerLimiter.run('gmail', () => gmail.users.messages.list({ userId: 'me', q: `newer_than:${lookbackDays}d ${exclusions.join(' ')}`, maxResults }));
  const references = list.data.messages || [];
  const known = new Set(await getSignalSourceIds(connection.userId, 'gmail'));
  const fresh = references.filter(({ id }) => id && !known.has(id));
  const fetched: FetchedMessage[] = [];
  for (let index = 0; index < fresh.length; index += 5) {
    await checkpoint();
    await progress({ phase: 'fetching', done: index, total: fresh.length, message: `Fetching message ${Math.min(index + 5, fresh.length)} of ${fresh.length}` });
    const batch = await Promise.all(fresh.slice(index, index + 5).map(({ id }) => providerLimiter.run('gmail', () => gmail.users.messages.get({ userId: 'me', id: id!, format: 'full' })).then(({ data }) => parseMessage(data, connection.accountEmail))));
    fetched.push(...batch);
  }

  await checkpoint();
  await progress({ phase: 'processing', done: 0, total: fetched.length, message: 'Classifying messages' });
  const memories = await listMemories(connection.userId, { enabledOnly: true });
  const senders = settings.blockedSenders.map((value) => value.toLowerCase()).filter(Boolean);
  const keywords = settings.blockedKeywords.map((value) => value.toLowerCase()).filter(Boolean);
  const messages = fetched.filter((message) => !senders.some((value) => message.from.toLowerCase().includes(value)) && !keywords.some((value) => `${message.subject} ${message.text}`.toLowerCase().includes(value)) && !isIgnored(memories, message.from));

  const inbound = messages.filter((message) => message.direction === 'inbound');
  const restricted = inbound.filter((message) => requiresLocalProcessing(memories, message.from));
  const open = inbound.filter((message) => !restricted.includes(message));
  const understood = [
    ...(await understandMessages(open, settings, connection.userId)),
    ...(await understandMessages(restricted, { ...settings, aiProvider: 'rules' }, connection.userId))
  ];

  const items: IngestItem[] = [];
  let done = 0;
  for (const message of messages) {
    await checkpoint();
    const metadataBase = { account: connection.label, connectionId: connection.id, threadId: message.threadId, rfcMessageId: message.rfcId, fromAddress: fromAddressOf(message.from), replyTo: message.replyTo ? fromAddressOf(message.replyTo) : undefined, toRaw: message.to?.slice(0, 300), direction: message.direction };
    let signal: Signal;
    let taskTitle: string | null = null;
    if (message.direction === 'outbound') {
      signal = { id: stableSignalId(connection.userId, message.id), userId: connection.userId, source: 'gmail', sourceId: message.id, sender: 'You', title: message.subject, summary: message.text.slice(0, 170) || 'Message you sent.', occurredAt: safeDate(message.date), category: 'people', priority: 'later', read: true, metadata: metadataBase };
    } else {
      const item = understood.find((candidate) => candidate.sourceId === message.id);
      if (!item) continue;
      const adjusted = adjustTriage(memories, message.from, { category: item.category, priority: item.priority });
      signal = { id: stableSignalId(connection.userId, item.sourceId), userId: connection.userId, source: 'gmail', sourceId: item.sourceId, sender: item.sender, title: item.title, summary: item.summary, occurredAt: safeDate(message.date), category: adjusted.category, priority: adjusted.priority, read: false, metadata: metadataBase };
      taskTitle = adjusted.category === 'noise' ? null : item.task;
    }
    await upsertSignal(signal);
    if (taskTitle) await createTask(connection.userId, { title: taskTitle, priority: signal.priority, source: 'gmail', sourceSignalId: signal.id });
    items.push({ signal, message });
    done += 1;
    if (done % 5 === 0) await progress({ phase: 'processing', done, total: messages.length, message: 'Saving signals' });
  }

  await progress({ phase: 'processing', done: messages.length, total: messages.length, message: 'Updating your brief and agent suggestions' });
  connection.lastSyncedAt = new Date().toISOString();
  connection.lastSyncAttemptAt = connection.lastSyncedAt;
  connection.status = 'connected';
  connection.lastSyncError = undefined;
  await upsertConnection(connection);
  const visible = (await getSignals(connection.userId)).filter((signal) => signal.metadata?.direction !== 'outbound');
  await saveBrief(connection.userId, await buildBrief(visible, settings, connection.userId));

  try {
    await ingestNewMessages(connection.userId, connection, items);
  } catch (error) {
    logSafe('agent ingest', error);
    await logActivity(connection.userId, { type: 'agent', status: 'error', title: 'Agent suggestions could not be prepared', detail: diagnose(error).message, action: diagnose(error).action }).catch(() => undefined);
  }
  return { fetched: fetched.length, processed: messages.length };
}

export interface SyncSummary {
  connections: number;
  fetched: number;
  processed: number;
}

export async function runSyncUser(userId: string, hooks: SyncHooks = {}): Promise<SyncSummary> {
  const connections = await getConnections(userId);
  const gmailConnections = connections.filter((connection) => connection.provider === 'gmail' && (connection.status === 'connected' || connection.status === 'error'));
  await logActivity(userId, { type: 'sync', status: 'info', title: 'Sync started', detail: gmailConnections.length ? `Checking ${gmailConnections.length} Gmail connection${gmailConnections.length === 1 ? '' : 's'}.` : 'No Gmail connection is available.' }).catch(console.error);
  const results = await Promise.allSettled(gmailConnections.map((connection) => syncGmailConnection(connection, hooks)));
  const failures: string[] = [];
  let retryable = false;
  let fetched = 0;
  let processed = 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === 'fulfilled') {
      fetched += result.value?.fetched || 0;
      processed += result.value?.processed || 0;
      continue;
    }
    if (result.reason instanceof Error && result.reason.name === 'JobCanceledError') throw result.reason;
    const connection = gmailConnections[index];
    const diagnosis = diagnose(result.reason);
    connection.status = 'error';
    connection.lastSyncAttemptAt = new Date().toISOString();
    connection.lastSyncError = `${diagnosis.message} ${diagnosis.action}`;
    retryable = retryable || diagnosis.retryable;
    await upsertConnection(connection);
    failures.push(`${connection.label}: ${connection.lastSyncError}`);
    logSafe(`gmail sync ${connection.label}`, result.reason);
  }
  if (failures.length) {
    await logActivity(userId, { type: 'sync', status: 'error', title: 'Sync needs attention', detail: failures.join(' '), action: 'Open Connections, correct the reported issue, then select Sync now.' }).catch(console.error);
    throw new ActionableError(failures.join(' '), { action: 'Open Connections, correct the reported issue, then select Sync now.', retryable, code: 'sync_failed' });
  }
  await logActivity(userId, { type: 'sync', status: 'success', title: 'Sync completed', detail: gmailConnections.length ? `Fetched ${fetched} new messages and processed ${processed}. Previously processed and filtered messages were skipped.` : 'Nothing was synced because Gmail is not connected.', action: gmailConnections.length ? undefined : 'Connect Gmail to begin.' }).catch(console.error);
  return { connections: gmailConnections.length, fetched, processed };
}
