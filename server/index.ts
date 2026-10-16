import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import cron from 'node-cron';
import { google } from 'googleapis';
import { decrypt, encrypt, signSession, verifySession } from './crypto.js';
import { demoUser } from './demo.js';
import { oauthClient, syncUser } from './gmail.js';
import { createTask, deleteConnection, deleteUser, getBrief, getConnections, getSignals, getTasks, getUser, initStore, pool, pruneOldSignals, updateTask, upsertConnection, upsertUser } from './store.js';
import type { Connection, DashboardData, User } from './types.js';
import { aiStatus } from './ai.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cookieParser());
app.use('/auth',rateLimit({windowMs:15*60_000,limit:40,standardHeaders:'draft-8',legacyHeaders:false}));
app.use('/api',rateLimit({windowMs:60_000,limit:180,standardHeaders:'draft-8',legacyHeaders:false}));
app.use((req,res,next)=>{if(['POST','PATCH','PUT','DELETE'].includes(req.method)){const origin=req.get('origin');const expected=process.env.APP_URL?new URL(process.env.APP_URL).origin:null;if(origin&&expected&&origin!==expected)return res.status(403).json({error:'Origin not allowed'});}next();});

function userId(req: express.Request) { return verifySession(req.cookies.orbit_session) || (process.env.DEMO_MODE === 'false' ? null : demoUser.id); }
function requireUser(req: express.Request, res: express.Response, next: express.NextFunction) { const id = userId(req); if (!id) return res.status(401).json({ error: 'Not authenticated' }); res.locals.userId = id; next(); }

app.get('/health', (_req, res) => res.json({ ok: true, database: pool ? 'postgres' : 'memory', time: new Date().toISOString() }));
app.get('/api/config', (_req, res) => res.json({ selfHosted:true, singleTenant:true, ownerConfigured:!!process.env.OWNER_EMAIL, databaseConfigured:!!pool, gmailConfigured:!!process.env.GOOGLE_CLIENT_ID&&!!process.env.GOOGLE_CLIENT_SECRET, ai:aiStatus(), privacy:{rawBodiesStored:false,signalRetentionDays:Number(process.env.SIGNAL_RETENTION_DAYS||30),telemetry:false}, demoMode:process.env.DEMO_MODE==='true' }));
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.redirect('/?setup=gmail');
  const state = crypto.randomBytes(20).toString('hex');
  res.cookie('orbit_oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 600_000 });
  const currentUserId = userId(req);
  if (currentUserId) res.cookie('orbit_link_user', signSession(currentUserId), { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 600_000 });
  res.redirect(oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', state, scope: ['openid','email','profile','https://www.googleapis.com/auth/gmail.readonly'] }));
});
app.get('/auth/google/callback', async (req, res, next) => {
  try {
    if (!req.query.state || req.query.state !== req.cookies.orbit_oauth_state) return res.status(400).send('Invalid OAuth state');
    const client = oauthClient(); const { tokens } = await client.getToken(String(req.query.code)); client.setCredentials(tokens);
    const oauth = google.oauth2({ version: 'v2', auth: client }); const { data } = await oauth.userinfo.get();
    const ownerEmail=process.env.OWNER_EMAIL?.trim().toLowerCase();
    if(ownerEmail&&data.email?.toLowerCase()!==ownerEmail)return res.status(403).send('This private Orbit instance only allows its configured owner.');
    const linkedUserId = verifySession(req.cookies.orbit_link_user);
    const linkedUser = linkedUserId ? await getUser(linkedUserId) : null;
    const googleUser: User = { id: data.id!, email: data.email!, name: data.name || data.email!.split('@')[0], avatar: data.picture || undefined, createdAt: new Date().toISOString() };
    const user = linkedUser || googleUser;
    if (!linkedUser) await upsertUser(user);
    const connection: Connection = { id: crypto.createHash('sha1').update(`gmail:${user.id}:${googleUser.email}`).digest('hex'), userId: user.id, provider: 'gmail', label: linkedUser ? `Gmail · ${googleUser.email}` : 'Gmail', accountEmail: googleUser.email, status: 'connected', encryptedTokens: encrypt(tokens) };
    await upsertConnection(connection);
    res.cookie('orbit_session', signSession(user.id), { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 30 * 86400_000 });
    res.clearCookie('orbit_oauth_state'); res.clearCookie('orbit_link_user'); res.redirect('/?connected=gmail');
    syncUser(user.id).catch(console.error);
  } catch (error) { next(error); }
});
app.post('/auth/demo', (_req, res) => { res.cookie('orbit_session', signSession(demoUser.id), { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 30 * 86400_000 }); res.json({ ok: true }); });
app.post('/auth/logout', (_req, res) => { res.clearCookie('orbit_session'); res.json({ ok: true }); });

app.get('/api/dashboard', requireUser, async (_req, res) => {
  const id = res.locals.userId; const user = await getUser(id); if (!user) return res.status(404).json({ error: 'User not found' });
  const [signals, tasks, connections, brief] = await Promise.all([getSignals(id), getTasks(id), getConnections(id), getBrief(id)]);
  const data: DashboardData = { user, mode: id === demoUser.id ? 'demo' : 'live', greeting: new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening',
    brief: brief || { headline: 'Your orbit is quiet.', narrative: 'Connect a source or add a task to begin.', wins: [], watchouts: [], generatedAt: new Date().toISOString() }, signals, tasks, connections,
    stats: { needsYou: signals.filter(s => s.category === 'action' && s.priority !== 'later').length, waitingOn: signals.filter(s => s.category === 'waiting').length, cleared: tasks.filter(t => t.status === 'done').length, noiseFiltered: signals.filter(s => s.category === 'noise').length + (id === demoUser.id ? 43 : 0) } };
  res.json(data);
});
app.post('/api/tasks', requireUser, async (req, res) => res.status(201).json(await createTask(res.locals.userId, req.body)));
app.patch('/api/tasks/:id', requireUser, async (req, res) => { const task = await updateTask(res.locals.userId, String(req.params.id), req.body.status); task ? res.json(task) : res.status(404).json({ error: 'Task not found' }); });
app.post('/api/sync', requireUser, async (_req, res, next) => { try { await syncUser(res.locals.userId); res.json({ ok: true, syncedAt: new Date().toISOString() }); } catch (e) { next(e); } });
app.get('/api/account/export',requireUser,async(_req,res)=>{const id=res.locals.userId;const [user,connections,signals,tasks,brief]=await Promise.all([getUser(id),getConnections(id),getSignals(id),getTasks(id),getBrief(id)]);res.setHeader('Content-Disposition','attachment; filename="orbit-export.json"');res.json({exportedAt:new Date().toISOString(),user,connections:connections.map(({encryptedTokens,...connection})=>connection),signals,tasks,brief});});
app.delete('/api/connections/:id',requireUser,async(req,res,next)=>{try{const connections=await getConnections(res.locals.userId);const connection=connections.find(c=>c.id===String(req.params.id));if(!connection)return res.status(404).json({error:'Connection not found'});if(connection.encryptedTokens){const tokens=decrypt<{access_token?:string;refresh_token?:string}>(connection.encryptedTokens);const token=tokens.refresh_token||tokens.access_token;if(token)await oauthClient().revokeToken(token).catch(()=>undefined);}await deleteConnection(res.locals.userId,connection.id);res.status(204).end();}catch(e){next(e);}});
app.delete('/api/account',requireUser,async(req,res,next)=>{try{if(req.body?.confirmation!=='DELETE')return res.status(400).json({error:'Type DELETE to confirm'});const connections=await getConnections(res.locals.userId);for(const connection of connections){if(!connection.encryptedTokens)continue;const tokens=decrypt<{access_token?:string;refresh_token?:string}>(connection.encryptedTokens);const token=tokens.refresh_token||tokens.access_token;if(token)await oauthClient().revokeToken(token).catch(()=>undefined);}await deleteUser(res.locals.userId);res.clearCookie('orbit_session');res.status(204).end();}catch(e){next(e);}});

if (production) { const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'); app.use(express.static(root)); app.get('/*splat', (_req, res) => res.sendFile(path.join(root, 'index.html'))); }
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { console.error(error); res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error' }); });

await initStore();
await pruneOldSignals();
cron.schedule(process.env.SYNC_CRON || '*/30 * * * *', async () => { if (!pool) return; const { rows } = await pool.query("SELECT DISTINCT user_id FROM connections WHERE status='connected'"); for (const row of rows) await syncUser(row.user_id).catch(console.error); });
cron.schedule('17 3 * * *', () => pruneOldSignals().catch(console.error));
app.listen(port, () => console.log(`Orbit listening on http://localhost:${port}`));
