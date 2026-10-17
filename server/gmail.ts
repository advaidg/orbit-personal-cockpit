import crypto from 'node:crypto';
import { google, gmail_v1 } from 'googleapis';
import { decrypt } from './crypto.js';
import { buildBrief, understandMessages } from './ai.js';
import { createTask, getConnections, getSettings, getSignals, getSignalSourceIds, logActivity, saveBrief, upsertConnection, upsertSignal } from './store.js';
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

function safeDate(value:string){const parsed=new Date(value);return Number.isNaN(parsed.getTime())?new Date().toISOString():parsed.toISOString();}

export async function syncGmailConnection(connection: Connection) {
  if (!connection.encryptedTokens) return;
  const auth = oauthClient(); auth.setCredentials(decrypt<GoogleTokens>(connection.encryptedTokens));
  const gmail = google.gmail({ version: 'v1', auth });
  const settings = await getSettings(connection.userId);
  const initial=!connection.lastSyncedAt;
  const lookbackDays=initial?settings.initialSyncLookbackDays:settings.syncLookbackDays;
  const maxResults=initial?settings.initialSyncMaxMessages:settings.syncMaxMessages;
  const exclusions=['-in:spam','-in:trash'];
  if(settings.excludePromotions)exclusions.push('-category:promotions');
  if(settings.excludeSocial)exclusions.push('-category:social');
  if(settings.excludeForums)exclusions.push('-category:forums');
  const list = await gmail.users.messages.list({ userId: 'me', q: `newer_than:${lookbackDays}d ${exclusions.join(' ')}`, maxResults });
  const fetched = await Promise.all((list.data.messages || []).map(async ({ id }) => {
    const { data } = await gmail.users.messages.get({ userId: 'me', id: id!, format: 'full' });
    const headers = Object.fromEntries((data.payload?.headers || []).map(h => [h.name?.toLowerCase(), h.value]));
    const internalTime=Number(data.internalDate);
    return { id: id!, from: headers.from || 'Unknown sender', subject: headers.subject || '(no subject)', date: headers.date || (Number.isFinite(internalTime)?new Date(internalTime).toISOString():new Date().toISOString()), text: bodyText(data.payload) || data.snippet || '' };
  }));
  const known=new Set(await getSignalSourceIds(connection.userId,'gmail'));
  const senders=settings.blockedSenders.map(value=>value.toLowerCase()).filter(Boolean);
  const keywords=settings.blockedKeywords.map(value=>value.toLowerCase()).filter(Boolean);
  const messages=fetched.filter(message=>!known.has(message.id)&&!senders.some(value=>message.from.toLowerCase().includes(value))&&!keywords.some(value=>`${message.subject} ${message.text}`.toLowerCase().includes(value)));
  const understood = await understandMessages(messages, settings, connection.userId);
  for (const item of understood) {
    const source = messages.find(m => m.id === item.sourceId)!;
    const signal: Signal = { id: crypto.randomUUID(), userId: connection.userId, source: 'gmail', sourceId: item.sourceId, sender: item.sender, title: item.title, summary: item.summary, occurredAt: safeDate(source.date), category: item.category, priority: item.priority, read: false, metadata: { account: connection.label } };
    await upsertSignal(signal);
    if (item.task) await createTask(connection.userId, { title: item.task, priority: item.priority, source: 'gmail', sourceSignalId: signal.id });
  }
  connection.lastSyncedAt = new Date().toISOString(); connection.lastSyncAttemptAt=connection.lastSyncedAt;connection.status = 'connected'; connection.lastSyncError=undefined; await upsertConnection(connection);
  await saveBrief(connection.userId, await buildBrief(await getSignals(connection.userId), settings, connection.userId));
  return{fetched:fetched.length,processed:messages.length};
}

const activeSyncs=new Map<string,Promise<{connections:number;fetched:number;processed:number}>>();

async function runSyncUser(userId: string) {
  const connections = await getConnections(userId);
  const gmailConnections=connections.filter(c=>c.provider==='gmail'&&(c.status==='connected'||c.status==='error'));
  await logActivity(userId,{type:'sync',status:'info',title:'Sync started',detail:gmailConnections.length?`Checking ${gmailConnections.length} Gmail connection${gmailConnections.length===1?'':'s'}.`:'No Gmail connection is available.'}).catch(console.error);
  const results=await Promise.allSettled(gmailConnections.map(syncGmailConnection));
  const failures:string[]=[];let fetched=0;let processed=0;
  for(let index=0;index<results.length;index++){const result=results[index];if(result.status==='fulfilled'){fetched+=result.value?.fetched||0;processed+=result.value?.processed||0;continue;}const connection=gmailConnections[index];const detail=result.reason instanceof Error?result.reason.message:'Unknown sync error';connection.status='error';connection.lastSyncAttemptAt=new Date().toISOString();connection.lastSyncError=/invalid_grant|unauthorized/i.test(detail)?'Gmail authorization expired. Disconnect and reconnect this account.':/AI provider|ChatGPT|OpenAI|Anthropic|model/i.test(detail)?'The selected AI provider failed. Check Intelligence settings, then retry.':'Gmail sync failed. Check the connection and try again.';await upsertConnection(connection);failures.push(`${connection.label}: ${connection.lastSyncError}`);console.error(result.reason);}
  if(failures.length){await logActivity(userId,{type:'sync',status:'error',title:'Sync needs attention',detail:failures.join(' '),action:'Open Settings → Connected sources, correct the reported issue, then select Sync now.'}).catch(console.error);throw new Error(failures.join(' '));}
  await logActivity(userId,{type:'sync',status:'success',title:'Sync completed',detail:gmailConnections.length?`Fetched ${fetched} messages and processed ${processed} new messages. Previously processed and filtered messages were skipped.`:'Nothing was synced because Gmail is not connected.',action:gmailConnections.length?undefined:'Connect Gmail to begin.'}).catch(console.error);
  return{connections:gmailConnections.length,fetched,processed};
}

export async function syncUser(userId:string){const current=activeSyncs.get(userId);if(current)return current;const operation=runSyncUser(userId).finally(()=>activeSyncs.delete(userId));activeSyncs.set(userId,operation);return operation;}
