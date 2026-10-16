import crypto from 'node:crypto';
import pg from 'pg';
import { demoBrief, demoConnections, demoSignals, demoTasks, demoUser } from './demo.js';
import type { Brief, Connection, Signal, Task, User } from './types.js';

const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined }) : null;
const memory = {
  users: new Map<string, User>([[demoUser.id, demoUser]]),
  connections: [...demoConnections], signals: [...demoSignals], tasks: [...demoTasks], briefs: new Map<string, Brief>([[demoUser.id, demoBrief]])
};

export async function initStore() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, avatar TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL, label TEXT NOT NULL, account_email TEXT, status TEXT NOT NULL, last_synced_at TIMESTAMPTZ, encrypted_tokens TEXT, UNIQUE(user_id, provider, account_email));
    CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, source TEXT NOT NULL, source_id TEXT NOT NULL, sender TEXT, title TEXT NOT NULL, summary TEXT, occurred_at TIMESTAMPTZ, category TEXT, priority TEXT, read BOOLEAN DEFAULT FALSE, metadata JSONB DEFAULT '{}', UNIQUE(user_id, source, source_id));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, note TEXT, due_at TIMESTAMPTZ, priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL, source_signal_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS briefs (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data JSONB NOT NULL, generated_at TIMESTAMPTZ DEFAULT NOW());
  `);
  if (process.env.DEMO_MODE !== 'false') {
    await pool.query('INSERT INTO users(id,email,name,avatar,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING', [demoUser.id,demoUser.email,demoUser.name,demoUser.avatar || null,demoUser.createdAt]);
    for (const c of demoConnections) await pool.query('INSERT INTO connections(id,user_id,provider,label,account_email,status,last_synced_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING', [c.id,c.userId,c.provider,c.label,c.accountEmail || null,c.status,c.lastSyncedAt || null]);
    for (const s of demoSignals) await pool.query('INSERT INTO signals(id,user_id,source,source_id,sender,title,summary,occurred_at,category,priority,read,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING', [s.id,s.userId,s.source,s.sourceId,s.sender,s.title,s.summary,s.occurredAt,s.category,s.priority,s.read,s.metadata || {}]);
    for (const t of demoTasks) await pool.query('INSERT INTO tasks(id,user_id,title,note,due_at,priority,status,source,source_signal_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING', [t.id,t.userId,t.title,t.note || null,t.dueAt || null,t.priority,t.status,t.source,t.sourceSignalId || null,t.createdAt]);
    await pool.query('INSERT INTO briefs(user_id,data,generated_at) VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING', [demoUser.id,demoBrief,demoBrief.generatedAt]);
  }
}

const rowsTo = {
  user: (r: any): User => ({ id: r.id, email: r.email, name: r.name, avatar: r.avatar, createdAt: r.created_at }),
  connection: (r: any): Connection => ({ id: r.id, userId: r.user_id, provider: r.provider, label: r.label, accountEmail: r.account_email, status: r.status, lastSyncedAt: r.last_synced_at, encryptedTokens: r.encrypted_tokens }),
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
  await pool.query(`INSERT INTO connections(id,user_id,provider,label,account_email,status,last_synced_at,encrypted_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(id) DO UPDATE SET label=$4,account_email=$5,status=$6,last_synced_at=$7,encrypted_tokens=COALESCE($8,connections.encrypted_tokens)`, [c.id,c.userId,c.provider,c.label,c.accountEmail,c.status,c.lastSyncedAt,c.encryptedTokens]);
}
export async function getSignals(userId: string) {
  if (!pool) return memory.signals.filter(x => x.userId === userId).sort((a,b) => b.occurredAt.localeCompare(a.occurredAt));
  const { rows } = await pool.query('SELECT * FROM signals WHERE user_id=$1 ORDER BY occurred_at DESC LIMIT 100', [userId]); return rows.map(rowsTo.signal);
}
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
export { pool };
