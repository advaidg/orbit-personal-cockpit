import crypto from 'node:crypto';
import pg from 'pg';
import { demoBrief, demoConnections, demoSignals, demoTasks, demoUser } from './demo.js';
import type { ActivityEvent, AiProvider, Brief, Connection, Signal, Task, User, UserSettings } from './types.js';

const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined }) : null;
const memory = {
  users: new Map<string, User>([[demoUser.id, demoUser]]),
  connections: [...demoConnections], signals: [...demoSignals], tasks: [...demoTasks], briefs: new Map<string, Brief>([[demoUser.id, demoBrief]]), settings: new Map<string, UserSettings>(), chatgpt: new Map<string, ChatGPTConnection>(), activity:[] as ActivityEvent[]
};

export type ChatGPTConnection = { userId:string; clientId?:string; hostId:string; email?:string; subject?:string; encryptedCredentials?:string; updatedAt?:string };

export async function initStore() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, avatar TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL, label TEXT NOT NULL, account_email TEXT, status TEXT NOT NULL, last_synced_at TIMESTAMPTZ, last_sync_attempt_at TIMESTAMPTZ, last_sync_error TEXT, encrypted_tokens TEXT, UNIQUE(user_id, provider, account_email));
    ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_sync_error TEXT;
    ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_sync_attempt_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, source TEXT NOT NULL, source_id TEXT NOT NULL, sender TEXT, title TEXT NOT NULL, summary TEXT, occurred_at TIMESTAMPTZ, category TEXT, priority TEXT, read BOOLEAN DEFAULT FALSE, metadata JSONB DEFAULT '{}', UNIQUE(user_id, source, source_id));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, note TEXT, due_at TIMESTAMPTZ, priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL, source_signal_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS briefs (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data JSONB NOT NULL, generated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, ai_provider TEXT NOT NULL DEFAULT 'rules', ai_input_chars INTEGER NOT NULL DEFAULT 1800, chatgpt_model TEXT, auto_sync BOOLEAN NOT NULL DEFAULT TRUE, sync_interval_minutes INTEGER NOT NULL DEFAULT 30, sync_lookback_days INTEGER NOT NULL DEFAULT 7, initial_sync_lookback_days INTEGER NOT NULL DEFAULT 30, sync_max_messages INTEGER NOT NULL DEFAULT 35, initial_sync_max_messages INTEGER NOT NULL DEFAULT 100, exclude_promotions BOOLEAN NOT NULL DEFAULT TRUE, exclude_social BOOLEAN NOT NULL DEFAULT TRUE, exclude_forums BOOLEAN NOT NULL DEFAULT FALSE, blocked_senders JSONB NOT NULL DEFAULT '[]', blocked_keywords JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ DEFAULT NOW());
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS chatgpt_model TEXT;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_sync BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sync_interval_minutes INTEGER NOT NULL DEFAULT 30;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sync_lookback_days INTEGER NOT NULL DEFAULT 7;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS initial_sync_lookback_days INTEGER NOT NULL DEFAULT 30;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sync_max_messages INTEGER NOT NULL DEFAULT 35;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS initial_sync_max_messages INTEGER NOT NULL DEFAULT 100;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS exclude_promotions BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS exclude_social BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS exclude_forums BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS blocked_senders JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS blocked_keywords JSONB NOT NULL DEFAULT '[]';
    CREATE TABLE IF NOT EXISTS chatgpt_connections (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, client_id TEXT, host_id TEXT NOT NULL, email TEXT, subject TEXT, encrypted_credentials TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS activity_events (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, action TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS activity_events_user_created_idx ON activity_events(user_id,created_at DESC);
  `);
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
  signal: (r: any): Signal => ({ id: r.id, userId: r.user_id, source: r.source, sourceId: r.source_id, sender: r.sender, title: r.title, summary: r.summary, occurredAt: r.occurred_at, category: r.category, priority: r.priority, read: r.read, metadata: r.metadata }),
  task: (r: any): Task => ({ id: r.id, userId: r.user_id, title: r.title, note: r.note, dueAt: r.due_at, priority: r.priority, status: r.status, source: r.source, sourceSignalId: r.source_signal_id, createdAt: r.created_at })
};

export async function getUser(id: string) {
  if (!pool) return memory.users.get(id) || null;
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]); return rows[0] ? rowsTo.user(rows[0]) : null;
}
export async function upsertUser(user: User) {
  if (!pool) { memory.users.set(user.id, user); return; }
  await pool.query('INSERT INTO users(id,email,name,avatar) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET name=$3,avatar=$4', [user.id, user.email, user.name, user.avatar]);
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
  if(!pool){const signals=memory.signals.filter(item=>item.userId===userId).length;const tasks=memory.tasks.filter(item=>item.userId===userId&&!!item.sourceSignalId).length;memory.signals=memory.signals.filter(item=>item.userId!==userId);memory.tasks=memory.tasks.filter(item=>item.userId!==userId||!item.sourceSignalId);memory.briefs.delete(userId);memory.connections.forEach(connection=>{if(connection.userId===userId){connection.lastSyncedAt=undefined;connection.lastSyncAttemptAt=undefined;connection.lastSyncError=undefined;if(connection.encryptedTokens)connection.status='connected';}});return{signals,tasks};}
  const client=await pool.connect();try{await client.query('BEGIN');const tasks=await client.query('DELETE FROM tasks WHERE user_id=$1 AND source_signal_id IS NOT NULL',[userId]);const signals=await client.query('DELETE FROM signals WHERE user_id=$1',[userId]);await client.query('DELETE FROM briefs WHERE user_id=$1',[userId]);await client.query("UPDATE connections SET last_synced_at=NULL,last_sync_attempt_at=NULL,last_sync_error=NULL,status=CASE WHEN encrypted_tokens IS NOT NULL THEN 'connected' ELSE status END WHERE user_id=$1",[userId]);await client.query('COMMIT');return{signals:signals.rowCount||0,tasks:tasks.rowCount||0};}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
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
  if(!pool){memory.users.delete(userId);memory.connections=memory.connections.filter(x=>x.userId!==userId);memory.signals=memory.signals.filter(x=>x.userId!==userId);memory.tasks=memory.tasks.filter(x=>x.userId!==userId);memory.briefs.delete(userId);memory.settings.delete(userId);memory.chatgpt.delete(userId);memory.activity=memory.activity.filter(x=>x.userId!==userId);return;}
  await pool.query('DELETE FROM users WHERE id=$1',[userId]);
}
export { pool };
