import crypto from 'node:crypto';
import { pool } from './pool.js';
import { runMigrations } from './migrations.js';
import { purgeMemoryUser } from './collection.js';
import { purgeMemoryJobs } from './jobs.js';
import { demoBrief, demoConnections, demoSignals, demoTasks, demoUser } from './demo.js';
import type { ActivityEvent, AiProvider, Brief, Connection, Signal, Task, User, UserSettings } from './types.js';

const memory = {
  users: new Map<string, User>([[demoUser.id, demoUser]]),
  connections: [...demoConnections], signals: [...demoSignals], tasks: [...demoTasks], briefs: new Map<string, Brief>([[demoUser.id, demoBrief]]), settings: new Map<string, UserSettings>(), chatgpt: new Map<string, ChatGPTConnection>(), passwords: new Map<string,PasswordAuth>(), activity:[] as ActivityEvent[]
};

export type ChatGPTConnection = { userId:string; clientId?:string; hostId:string; email?:string; subject?:string; encryptedCredentials?:string; updatedAt?:string };
export type PasswordAuth = { userId:string; salt:string; hash:string; updatedAt?:string };

export async function initStore() {
  if (!pool) return;
  await runMigrations(pool);
  if (process.env.DEMO_MODE !== 'false') {
    await pool.query('INSERT INTO users(id,email,name,avatar,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING', [demoUser.id,demoUser.email,demoUser.name,demoUser.avatar || null,demoUser.createdAt]);
    for (const c of demoConnections) await pool.query('INSERT INTO connections(id,user_id,provider,label,account_email,status,last_synced_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING', [c.id,c.userId,c.provider,c.label,c.accountEmail || null,c.status,c.lastSyncedAt || null]);
    for (const s of demoSignals) await pool.query('INSERT INTO signals(id,user_id,source,source_id,sender,title,summary,occurred_at,category,priority,read,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING', [s.id,s.userId,s.source,s.sourceId,s.sender,s.title,s.summary,s.occurredAt,s.category,s.priority,s.read,s.metadata || {}]);
    for (const t of demoTasks) await pool.query('INSERT INTO tasks(id,user_id,title,note,due_at,priority,status,source,source_signal_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING', [t.id,t.userId,t.title,t.note || null,t.dueAt || null,t.priority,t.status,t.source,t.sourceSignalId || null,t.createdAt]);
    await pool.query('INSERT INTO briefs(user_id,data,generated_at) VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING', [demoUser.id,demoBrief,demoBrief.generatedAt]);
  } else {
    await pool.query('DELETE FROM users WHERE id=$1', [demoUser.id]);
  }
}

const rowsTo = {
  user: (r: any): User => ({ id: r.id, email: r.email, name: r.name, avatar: r.avatar, createdAt: r.created_at }),
  connection: (r: any): Connection => ({ id: r.id, userId: r.user_id, provider: r.provider, label: r.label, accountEmail: r.account_email, status: r.status, lastSyncedAt: r.last_synced_at?.toISOString?.() || r.last_synced_at || undefined, lastSyncAttemptAt:r.last_sync_attempt_at?.toISOString?.()||r.last_sync_attempt_at||undefined, lastSyncError:r.last_sync_error||undefined, encryptedTokens: r.encrypted_tokens }),
  signal: (r: any): Signal => ({ id: r.id, userId: r.user_id, source: r.source, sourceId: r.source_id, sender: r.sender, title: r.title, summary: r.summary, occurredAt: r.occurred_at?.toISOString?.() ?? r.occurred_at, category: r.category, priority: r.priority, read: r.read, metadata: r.metadata }),
  task: (r: any): Task => ({ id: r.id, userId: r.user_id, title: r.title, note: r.note ?? undefined, dueAt: r.due_at?.toISOString?.() ?? r.due_at ?? undefined, priority: r.priority, status: r.status, source: r.source, sourceSignalId: r.source_signal_id ?? undefined, createdAt: r.created_at?.toISOString?.() ?? r.created_at })
};

export async function getUser(id: string) {
  if (!pool) return memory.users.get(id) || null;
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]); return rows[0] ? rowsTo.user(rows[0]) : null;
}
export async function getUserByEmail(email:string) {
  const normalized=email.trim().toLowerCase();
  if(!pool)return [...memory.users.values()].find(user=>user.email.toLowerCase()===normalized)||null;
  const {rows}=await pool.query('SELECT * FROM users WHERE LOWER(email)=$1',[normalized]);return rows[0]?rowsTo.user(rows[0]):null;
}
export async function upsertUser(user: User) {
  if (!pool) { memory.users.set(user.id, user); return; }
  await pool.query('INSERT INTO users(id,email,name,avatar) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET name=$3,avatar=$4', [user.id, user.email, user.name, user.avatar]);
}
export async function getPasswordAuth(userId:string){
  if(!pool)return memory.passwords.get(userId)||null;
  const {rows}=await pool.query('SELECT * FROM owner_auth WHERE user_id=$1',[userId]);const row=rows[0];return row?{userId:row.user_id,salt:row.password_salt,hash:row.password_hash,updatedAt:row.updated_at?.toISOString?.()||row.updated_at}:null;
}
export async function savePasswordAuth(auth:PasswordAuth){
  if(!pool){memory.passwords.set(auth.userId,{...auth,updatedAt:new Date().toISOString()});return;}
  await pool.query('INSERT INTO owner_auth(user_id,password_salt,password_hash,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(user_id) DO UPDATE SET password_salt=$2,password_hash=$3,updated_at=NOW()',[auth.userId,auth.salt,auth.hash]);
}
export async function getConnections(userId: string) {
  if (!pool) return memory.connections.filter(x => x.userId === userId);
  const { rows } = await pool.query('SELECT * FROM connections WHERE user_id=$1 ORDER BY label', [userId]); return rows.map(rowsTo.connection);
}
export async function upsertConnection(c: Connection) {
  if (!pool) { const i = memory.connections.findIndex(x => x.id === c.id); i >= 0 ? memory.connections[i] = c : memory.connections.push(c); return; }
  await pool.query(`INSERT INTO connections(id,user_id,provider,label,account_email,status,last_synced_at,last_sync_attempt_at,last_sync_error,encrypted_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(id) DO UPDATE SET label=$4,account_email=$5,status=$6,last_synced_at=$7,last_sync_attempt_at=$8,last_sync_error=$9,encrypted_tokens=COALESCE($10,connections.encrypted_tokens)`, [c.id,c.userId,c.provider,c.label,c.accountEmail,c.status,c.lastSyncedAt,c.lastSyncAttemptAt,c.lastSyncError||null,c.encryptedTokens]);
}
export async function getSignals(userId: string) {
  if (!pool) return memory.signals.filter(x => x.userId === userId).sort((a,b) => b.occurredAt.localeCompare(a.occurredAt));
  const { rows } = await pool.query('SELECT * FROM signals WHERE user_id=$1 ORDER BY occurred_at DESC LIMIT 100', [userId]); return rows.map(rowsTo.signal);
}
export async function getSignalSourceIds(userId:string,source:Signal['source']){if(!pool)return memory.signals.filter(item=>item.userId===userId&&item.source===source).map(item=>item.sourceId);const {rows}=await pool.query('SELECT source_id FROM signals WHERE user_id=$1 AND source=$2',[userId,source]);return rows.map(row=>String(row.source_id));}
export async function upsertSignal(s: Signal) {
  if (!pool) { const i = memory.signals.findIndex(x => x.userId === s.userId && x.source === s.source && x.sourceId === s.sourceId); i >= 0 ? memory.signals[i] = s : memory.signals.push(s); return; }
  await pool.query(`INSERT INTO signals(id,user_id,source,source_id,sender,title,summary,occurred_at,category,priority,read,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(user_id,source,source_id) DO UPDATE SET sender=$5,title=$6,summary=$7,occurred_at=$8,category=$9,priority=$10,metadata=$12`, [s.id,s.userId,s.source,s.sourceId,s.sender,s.title,s.summary,s.occurredAt,s.category,s.priority,s.read,s.metadata]);
}
export async function getTasks(userId: string) {
  if (!pool) return memory.tasks.filter(x => x.userId === userId).sort((a,b) => a.status.localeCompare(b.status));
  const { rows } = await pool.query('SELECT * FROM tasks WHERE user_id=$1 ORDER BY status, due_at NULLS LAST, created_at DESC', [userId]); return rows.map(rowsTo.task);
}
export async function createTask(userId: string, input: Partial<Task>) {
  const task: Task = { id: crypto.randomUUID(), userId, title: String(input.title || 'Untitled task'), note: input.note, dueAt: input.dueAt, priority: input.priority || 'soon', status: 'open', source: input.source || 'manual', sourceSignalId: input.sourceSignalId, createdAt: new Date().toISOString() };
  if (!pool) memory.tasks.push(task); else await pool.query('INSERT INTO tasks(id,user_id,title,note,due_at,priority,status,source,source_signal_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [task.id,task.userId,task.title,task.note,task.dueAt,task.priority,task.status,task.source,task.sourceSignalId,task.createdAt]);
  return task;
}
export async function updateTask(userId: string, id: string, status: Task['status']) {
  if (!pool) { const task = memory.tasks.find(x => x.id === id && x.userId === userId); if (task) task.status = status; return task || null; }
  const { rows } = await pool.query('UPDATE tasks SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING *', [status,id,userId]); return rows[0] ? rowsTo.task(rows[0]) : null;
}
export type TaskPatch = Partial<Pick<Task, 'title' | 'note' | 'dueAt' | 'priority' | 'status'>>;
export async function getTask(userId: string, id: string): Promise<Task | null> {
  if (!pool) { const task = memory.tasks.find(x => x.id === id && x.userId === userId); return task ? { ...task } : null; }
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id=$1 AND user_id=$2', [id, userId]); return rows[0] ? rowsTo.task(rows[0]) : null;
}
export async function patchTask(userId: string, id: string, patch: TaskPatch): Promise<Task | null> {
  const current = await getTask(userId, id); if (!current) return null;
  const next: Task = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
  if (!pool) { const index = memory.tasks.findIndex(x => x.id === id && x.userId === userId); memory.tasks[index] = next; return { ...next }; }
  const { rows } = await pool.query('UPDATE tasks SET title=$3,note=$4,due_at=$5,priority=$6,status=$7 WHERE id=$1 AND user_id=$2 RETURNING *', [id, userId, next.title, next.note ?? null, next.dueAt ?? null, next.priority, next.status]);
  return rows[0] ? rowsTo.task(rows[0]) : null;
}
export async function deleteTask(userId: string, id: string): Promise<boolean> {
  if (!pool) { const index = memory.tasks.findIndex(x => x.id === id && x.userId === userId); if (index < 0) return false; memory.tasks.splice(index, 1); return true; }
  const result = await pool.query('DELETE FROM tasks WHERE id=$1 AND user_id=$2', [id, userId]); return (result.rowCount ?? 0) > 0;
}
export async function getSignal(userId: string, id: string): Promise<Signal | null> {
  if (!pool) { const signal = memory.signals.find(x => x.id === id && x.userId === userId); return signal ? { ...signal } : null; }
  const { rows } = await pool.query('SELECT * FROM signals WHERE id=$1 AND user_id=$2', [id, userId]); return rows[0] ? rowsTo.signal(rows[0]) : null;
}
export type SignalPatch = { category?: Signal['category']; priority?: Signal['priority']; read?: boolean; metadata?: Record<string, unknown> };
/** Updates category/priority/read and shallow-merges `metadata` into the stored metadata. */
export async function patchSignal(userId: string, id: string, patch: SignalPatch): Promise<Signal | null> {
  const current = await getSignal(userId, id); if (!current) return null;
  const next: Signal = { ...current, category: patch.category ?? current.category, priority: patch.priority ?? current.priority, read: patch.read ?? current.read, metadata: { ...(current.metadata || {}), ...(patch.metadata || {}) } };
  if (!pool) { const index = memory.signals.findIndex(x => x.id === id && x.userId === userId); memory.signals[index] = next; return { ...next }; }
  const { rows } = await pool.query('UPDATE signals SET category=$3,priority=$4,read=$5,metadata=$6 WHERE id=$1 AND user_id=$2 RETURNING *', [id, userId, next.category, next.priority, next.read, JSON.stringify(next.metadata)]);
  return rows[0] ? rowsTo.signal(rows[0]) : null;
}
/** Snoozed signals whose wake-up time has passed (all owners). */
export async function getSnoozedSignalsDue(now: Date): Promise<Signal[]> {
  if (!pool) return memory.signals.filter(signal => { const state = (signal.metadata?.state ?? {}) as { status?: string; snoozedUntil?: string }; return state.status === 'snoozed' && !!state.snoozedUntil && state.snoozedUntil <= now.toISOString(); }).map(signal => ({ ...signal }));
  const { rows } = await pool.query("SELECT * FROM signals WHERE metadata->'state'->>'status'='snoozed' AND (metadata->'state'->>'snoozedUntil')::timestamptz <= $1", [now.toISOString()]);
  return rows.map(rowsTo.signal);
}
export async function deleteSignalsBySourceIds(userId: string, source: Signal['source'], sourceIds: string[]): Promise<number> {
  if (!sourceIds.length) return 0;
  if (!pool) { const before = memory.signals.length; memory.signals = memory.signals.filter(signal => !(signal.userId === userId && signal.source === source && sourceIds.includes(signal.sourceId))); return before - memory.signals.length; }
  const result = await pool.query('DELETE FROM signals WHERE user_id=$1 AND source=$2 AND source_id = ANY($3::text[])', [userId, source, sourceIds]); return result.rowCount ?? 0;
}
export async function getBrief(userId: string) {
  if (!pool) return memory.briefs.get(userId) || null;
  const { rows } = await pool.query('SELECT data FROM briefs WHERE user_id=$1', [userId]); return (rows[0]?.data as Brief) || null;
}
export async function saveBrief(userId: string, brief: Brief) {
  if (!pool) memory.briefs.set(userId, brief); else await pool.query('INSERT INTO briefs(user_id,data,generated_at) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET data=$2,generated_at=$3', [userId, brief, brief.generatedAt]);
}
export async function logActivity(userId:string,event:Omit<ActivityEvent,'id'|'userId'|'createdAt'>){const item:ActivityEvent={id:crypto.randomUUID(),userId,createdAt:new Date().toISOString(),...event};if(!pool){memory.activity.unshift(item);const owned=memory.activity.map((entry,index)=>({entry,index})).filter(value=>value.entry.userId===userId);if(owned.length>200)memory.activity.splice(owned[owned.length-1].index,1);return item;}await pool.query('INSERT INTO activity_events(id,user_id,type,status,title,detail,action,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[item.id,userId,item.type,item.status,item.title,item.detail||null,item.action||null,item.createdAt]);await pool.query('DELETE FROM activity_events WHERE user_id=$1 AND id NOT IN (SELECT id FROM activity_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200)',[userId]);return item;}
export async function getActivity(userId:string,limit=40){if(!pool)return memory.activity.filter(item=>item.userId===userId).slice(0,limit);const {rows}=await pool.query('SELECT * FROM activity_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',[userId,limit]);return rows.map((row):ActivityEvent=>({id:row.id,userId:row.user_id,type:row.type,status:row.status,title:row.title,detail:row.detail||undefined,action:row.action||undefined,createdAt:row.created_at?.toISOString?.()||row.created_at}));}
export async function clearActivity(userId:string){if(!pool){memory.activity=memory.activity.filter(item=>item.userId!==userId);return;}await pool.query('DELETE FROM activity_events WHERE user_id=$1',[userId]);}
export async function getSettings(userId: string): Promise<UserSettings> {
  const fallback: UserSettings = { aiProvider: (process.env.AI_PROVIDER || 'rules') as AiProvider, aiInputChars: Math.min(8000, Math.max(200, Number(process.env.AI_INPUT_CHARS_PER_ITEM || 1800))), chatgptModel: process.env.CHATGPT_MODEL, autoSync:true, syncIntervalMinutes:30, syncLookbackDays:Math.max(1,Number(process.env.SYNC_LOOKBACK_DAYS||7)), initialSyncLookbackDays:Math.max(1,Number(process.env.INITIAL_SYNC_LOOKBACK_DAYS||30)), syncMaxMessages:Math.min(100,Math.max(1,Number(process.env.SYNC_MAX_MESSAGES||35))), initialSyncMaxMessages:Math.min(100,Math.max(1,Number(process.env.INITIAL_SYNC_MAX_MESSAGES||100))), excludePromotions:true, excludeSocial:true, excludeForums:false, blockedSenders:[], blockedKeywords:[] };
  if (!pool) return memory.settings.get(userId) || fallback;
  const { rows } = await pool.query('SELECT * FROM user_settings WHERE user_id=$1', [userId]);const row=rows[0];
  return row ? { aiProvider:row.ai_provider as AiProvider, aiInputChars:row.ai_input_chars, chatgptModel:row.chatgpt_model||undefined, autoSync:row.auto_sync, syncIntervalMinutes:row.sync_interval_minutes, syncLookbackDays:row.sync_lookback_days, initialSyncLookbackDays:row.initial_sync_lookback_days, syncMaxMessages:row.sync_max_messages, initialSyncMaxMessages:row.initial_sync_max_messages, excludePromotions:row.exclude_promotions, excludeSocial:row.exclude_social, excludeForums:row.exclude_forums, blockedSenders:row.blocked_senders||[], blockedKeywords:row.blocked_keywords||[] } : fallback;
}
export async function saveSettings(userId: string, settings: UserSettings) {
  if (!pool) { memory.settings.set(userId, settings); return settings; }
  await pool.query(`INSERT INTO user_settings(user_id,ai_provider,ai_input_chars,chatgpt_model,auto_sync,sync_interval_minutes,sync_lookback_days,initial_sync_lookback_days,sync_max_messages,initial_sync_max_messages,exclude_promotions,exclude_social,exclude_forums,blocked_senders,blocked_keywords,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
    ON CONFLICT(user_id) DO UPDATE SET ai_provider=$2,ai_input_chars=$3,chatgpt_model=$4,auto_sync=$5,sync_interval_minutes=$6,sync_lookback_days=$7,initial_sync_lookback_days=$8,sync_max_messages=$9,initial_sync_max_messages=$10,exclude_promotions=$11,exclude_social=$12,exclude_forums=$13,blocked_senders=$14,blocked_keywords=$15,updated_at=NOW()`, [userId,settings.aiProvider,settings.aiInputChars,settings.chatgptModel||null,settings.autoSync,settings.syncIntervalMinutes,settings.syncLookbackDays,settings.initialSyncLookbackDays,settings.syncMaxMessages,settings.initialSyncMaxMessages,settings.excludePromotions,settings.excludeSocial,settings.excludeForums,JSON.stringify(settings.blockedSenders),JSON.stringify(settings.blockedKeywords)]);
  return settings;
}

export async function clearDerivedData(userId:string){
  if(!pool){const signals=memory.signals.filter(item=>item.userId===userId).length;const derived=(item:Task)=>!!item.sourceSignalId&&item.source!=='manual';const tasks=memory.tasks.filter(item=>item.userId===userId&&derived(item)).length;memory.signals=memory.signals.filter(item=>item.userId!==userId);memory.tasks=memory.tasks.filter(item=>item.userId!==userId||!derived(item));memory.briefs.delete(userId);memory.connections.forEach(connection=>{if(connection.userId===userId){connection.lastSyncedAt=undefined;connection.lastSyncAttemptAt=undefined;connection.lastSyncError=undefined;if(connection.encryptedTokens)connection.status='connected';}});return{signals,tasks};}
  const client=await pool.connect();try{await client.query('BEGIN');const tasks=await client.query("DELETE FROM tasks WHERE user_id=$1 AND source_signal_id IS NOT NULL AND source <> 'manual'",[userId]);const signals=await client.query('DELETE FROM signals WHERE user_id=$1',[userId]);await client.query('DELETE FROM briefs WHERE user_id=$1',[userId]);await client.query("UPDATE connections SET last_synced_at=NULL,last_sync_attempt_at=NULL,last_sync_error=NULL,status=CASE WHEN encrypted_tokens IS NOT NULL THEN 'connected' ELSE status END WHERE user_id=$1",[userId]);await client.query('COMMIT');return{signals:signals.rowCount||0,tasks:tasks.rowCount||0};}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function ensureChatGPTHost(userId:string){
  const current=await getChatGPTConnection(userId);if(current)return current;
  const connection:ChatGPTConnection={userId,hostId:`urn:uuid:${crypto.randomUUID()}`,updatedAt:new Date().toISOString()};
  if(!pool){memory.chatgpt.set(userId,connection);return connection;}
  await pool.query('INSERT INTO chatgpt_connections(user_id,host_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',[userId,connection.hostId]);
  return (await getChatGPTConnection(userId))!;
}
export async function getChatGPTConnection(userId:string):Promise<ChatGPTConnection|null>{
  if(!pool)return memory.chatgpt.get(userId)||null;
  const {rows}=await pool.query('SELECT * FROM chatgpt_connections WHERE user_id=$1',[userId]);const row=rows[0];
  return row?{userId:row.user_id,clientId:row.client_id||undefined,hostId:row.host_id,email:row.email||undefined,subject:row.subject||undefined,encryptedCredentials:row.encrypted_credentials||undefined,updatedAt:row.updated_at?.toISOString?.()||row.updated_at}:null;
}
export async function saveChatGPTConnection(connection:ChatGPTConnection){
  connection.updatedAt=new Date().toISOString();
  if(!pool){memory.chatgpt.set(connection.userId,connection);return connection;}
  await pool.query(`INSERT INTO chatgpt_connections(user_id,client_id,host_id,email,subject,encrypted_credentials,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT(user_id) DO UPDATE SET client_id=$2,host_id=$3,email=$4,subject=$5,encrypted_credentials=$6,updated_at=NOW()`,[connection.userId,connection.clientId||null,connection.hostId,connection.email||null,connection.subject||null,connection.encryptedCredentials||null]);return connection;
}
export async function deleteChatGPTConnection(userId:string){if(!pool){memory.chatgpt.delete(userId);return;}await pool.query('DELETE FROM chatgpt_connections WHERE user_id=$1',[userId]);}
export async function pruneOldSignals() {
  if (!pool) return;
  const days = Math.max(1, Number(process.env.SIGNAL_RETENTION_DAYS || 30));
  await pool.query("DELETE FROM signals WHERE occurred_at < NOW() - ($1 * INTERVAL '1 day')", [days]);
}
export async function deleteConnection(userId:string,id:string){
  if(!pool){const index=memory.connections.findIndex(c=>c.id===id&&c.userId===userId);if(index<0)return null;return memory.connections.splice(index,1)[0];}
  const {rows}=await pool.query('DELETE FROM connections WHERE id=$1 AND user_id=$2 RETURNING *',[id,userId]);return rows[0]?rowsTo.connection(rows[0]):null;
}
export async function deleteUser(userId:string){
  if(!pool){memory.users.delete(userId);memory.connections=memory.connections.filter(x=>x.userId!==userId);memory.signals=memory.signals.filter(x=>x.userId!==userId);memory.tasks=memory.tasks.filter(x=>x.userId!==userId);memory.briefs.delete(userId);memory.settings.delete(userId);memory.chatgpt.delete(userId);memory.passwords.delete(userId);memory.activity=memory.activity.filter(x=>x.userId!==userId);purgeMemoryUser(userId);purgeMemoryJobs(userId);return;}
  await pool.query('DELETE FROM users WHERE id=$1',[userId]);
}
export { pool };
