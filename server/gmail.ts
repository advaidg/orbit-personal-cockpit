import crypto from 'node:crypto';
import { google, gmail_v1 } from 'googleapis';
import { decrypt } from './crypto.js';
import { buildBrief, understandMessages } from './ai.js';
import { createTask, getConnections, getSettings, getSignals, saveBrief, upsertConnection, upsertSignal } from './store.js';
import type { Connection, Signal } from './types.js';

type GoogleTokens = { access_token?: string | null; refresh_token?: string | null; scope?: string; token_type?: string | null; expiry_date?: number | null };

export function oauthClient() {
  const base = process.env.APP_URL || 'http://localhost:3000';
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${base}/auth/google/callback`);
}

function bodyText(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return '';
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return (payload.parts || []).map(bodyText).join(' ').slice(0, 6000);
}

export async function syncGmailConnection(connection: Connection) {
  if (!connection.encryptedTokens) return;
  const auth = oauthClient(); auth.setCredentials(decrypt<GoogleTokens>(connection.encryptedTokens));
  const gmail = google.gmail({ version: 'v1', auth });
  const lookbackDays = Math.max(1, Number(process.env.SYNC_LOOKBACK_DAYS || 7));
  const maxResults = Math.min(100, Math.max(1, Number(process.env.SYNC_MAX_MESSAGES || 35)));
  const list = await gmail.users.messages.list({ userId: 'me', q: `newer_than:${lookbackDays}d`, maxResults });
  const messages = await Promise.all((list.data.messages || []).map(async ({ id }) => {
    const { data } = await gmail.users.messages.get({ userId: 'me', id: id!, format: 'full' });
    const headers = Object.fromEntries((data.payload?.headers || []).map(h => [h.name?.toLowerCase(), h.value]));
    return { id: id!, from: headers.from || 'Unknown sender', subject: headers.subject || '(no subject)', date: headers.date || new Date(Number(data.internalDate)).toISOString(), text: bodyText(data.payload) || data.snippet || '' };
  }));
  const settings = await getSettings(connection.userId);
  const understood = await understandMessages(messages, settings);
  const existing = await getSignals(connection.userId);
  for (const item of understood) {
    const source = messages.find(m => m.id === item.sourceId)!;
    const signal: Signal = { id: crypto.randomUUID(), userId: connection.userId, source: 'gmail', sourceId: item.sourceId, sender: item.sender, title: item.title, summary: item.summary, occurredAt: new Date(source.date).toISOString(), category: item.category, priority: item.priority, read: false, metadata: { account: connection.label } };
    await upsertSignal(signal);
    if (item.task && !existing.some(s => s.sourceId === item.sourceId)) await createTask(connection.userId, { title: item.task, priority: item.priority, source: 'gmail', sourceSignalId: signal.id });
  }
  connection.lastSyncedAt = new Date().toISOString(); connection.status = 'connected'; await upsertConnection(connection);
  await saveBrief(connection.userId, await buildBrief(await getSignals(connection.userId), settings));
}

export async function syncUser(userId: string) {
  const connections = await getConnections(userId);
  await Promise.all(connections.filter(c => c.provider === 'gmail' && c.status === 'connected').map(syncGmailConnection));
}
