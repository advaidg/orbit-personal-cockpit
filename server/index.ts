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
import { clearDerivedData, createTask, deleteConnection, deleteUser, getBrief, getChatGPTConnection, getConnections, getSettings, getSignals, getTasks, getUser, initStore, pool, pruneOldSignals, saveSettings, updateTask, upsertConnection, upsertUser } from './store.js';
import type { AiProvider, Connection, DashboardData, User } from './types.js';
import { aiProviders, aiStatus, answerQuestion } from './ai.js';
import { chatGPTModels, chatGPTSetup, disconnectChatGPT, importChatGPTCredentials } from './chatgpt.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
if (production) {
  const required = ['APP_URL','OWNER_EMAIL','SESSION_SECRET','APP_ENCRYPTION_KEY','DATABASE_URL','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Refusing to start: missing required production settings: ${missing.join(', ')}`);
  if (process.env.SESSION_SECRET!.length < 32 || process.env.APP_ENCRYPTION_KEY!.length < 32) throw new Error('Refusing to start: security secrets must be at least 32 characters');
  if (process.env.SESSION_SECRET === process.env.APP_ENCRYPTION_KEY) throw new Error('Refusing to start: SESSION_SECRET and APP_ENCRYPTION_KEY must be different');
  if (new URL(process.env.APP_URL!).protocol !== 'https:') throw new Error('Refusing to start: APP_URL must use HTTPS in production');
}
const cookieNames = {
  session: production ? '__Host-orbit_session' : 'orbit_session',
  oauthState: production ? '__Host-orbit_oauth_state' : 'orbit_oauth_state',
  linkUser: production ? '__Host-orbit_link_user' : 'orbit_link_user'
};
const cookieBase = { httpOnly: true, sameSite: 'lax' as const, secure: production, path: '/' };
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc:["'self'"], scriptSrc:["'self'"], styleSrc:["'self'","'unsafe-inline'",'https://fonts.googleapis.com'], fontSrc:["'self'",'https://fonts.gstatic.com'], imgSrc:["'self'",'data:','https:'], connectSrc:["'self'"], objectSrc:["'none'"], baseUri:["'self'"], frameAncestors:["'none'"], formAction:["'self'",'https://accounts.google.com'] } } }));
app.use(express.json());
app.use(cookieParser());
app.use(['/auth','/api'], (_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
app.use('/auth',rateLimit({windowMs:15*60_000,limit:40,standardHeaders:'draft-8',legacyHeaders:false}));
app.use('/api',rateLimit({windowMs:60_000,limit:180,standardHeaders:'draft-8',legacyHeaders:false}));
app.use((req,res,next)=>{if(['POST','PATCH','PUT','DELETE'].includes(req.method)){const origin=req.get('origin');const expected=process.env.APP_URL?new URL(process.env.APP_URL).origin:null;const fetchSite=req.get('sec-fetch-site');if(fetchSite==='cross-site'||origin&&expected&&origin!==expected)return res.status(403).json({error:'Origin not allowed'});}next();});

function userId(req: express.Request) { return verifySession(req.cookies[cookieNames.session]) || (process.env.DEMO_MODE === 'false' ? null : demoUser.id); }
function requireUser(req: express.Request, res: express.Response, next: express.NextFunction) { const id = userId(req); if (!id) return res.status(401).json({ error: 'Not authenticated' }); res.locals.userId = id; next(); }

app.get('/health', (_req, res) => res.json({ ok: true, database: pool ? 'postgres' : 'memory', time: new Date().toISOString() }));
app.get('/api/config', (_req, res) => res.json({ selfHosted:true, singleTenant:true, ownerConfigured:!!process.env.OWNER_EMAIL, databaseConfigured:!!pool, gmailConfigured:!!process.env.GOOGLE_CLIENT_ID&&!!process.env.GOOGLE_CLIENT_SECRET, ai:aiStatus(), privacy:{rawBodiesStored:false,signalRetentionDays:Number(process.env.SIGNAL_RETENTION_DAYS||30),telemetry:false}, demoMode:process.env.DEMO_MODE==='true' }));
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.redirect('/?setup=gmail');
  const state = crypto.randomBytes(20).toString('hex');
  res.cookie(cookieNames.oauthState, state, { ...cookieBase, maxAge: 600_000 });
  const currentUserId = userId(req);
  if (currentUserId) res.cookie(cookieNames.linkUser, signSession(currentUserId, 600), { ...cookieBase, maxAge: 600_000 });
  res.redirect(oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', state, scope: ['openid','email','profile','https://www.googleapis.com/auth/gmail.readonly'] }));
});
app.get('/auth/google/callback', async (req, res, next) => {
  try {
    if (!req.query.state || req.query.state !== req.cookies[cookieNames.oauthState] || !req.query.code) return res.status(400).send('Invalid OAuth response');
    const client = oauthClient(); const { tokens } = await client.getToken(String(req.query.code)); client.setCredentials(tokens);
    const oauth = google.oauth2({ version: 'v2', auth: client }); const { data } = await oauth.userinfo.get();
    const ownerEmail=process.env.OWNER_EMAIL?.trim().toLowerCase();
    if(ownerEmail&&data.email?.toLowerCase()!==ownerEmail){await client.revokeCredentials().catch(()=>undefined);return res.status(403).send('This private Orbit instance only allows its configured owner.');}
    const linkedUserId = verifySession(req.cookies[cookieNames.linkUser]);
    const linkedUser = linkedUserId ? await getUser(linkedUserId) : null;
    const googleUser: User = { id: data.id!, email: data.email!, name: data.name || data.email!.split('@')[0], avatar: data.picture || undefined, createdAt: new Date().toISOString() };
    const user = linkedUser || googleUser;
    if (!linkedUser) await upsertUser(user);
    const connection: Connection = { id: crypto.createHash('sha1').update(`gmail:${user.id}:${googleUser.email}`).digest('hex'), userId: user.id, provider: 'gmail', label: linkedUser ? `Gmail · ${googleUser.email}` : 'Gmail', accountEmail: googleUser.email, status: 'connected', encryptedTokens: encrypt(tokens) };
    await upsertConnection(connection);
    res.cookie(cookieNames.session, signSession(user.id), { ...cookieBase, maxAge: 30 * 86400_000 });
    res.clearCookie(cookieNames.oauthState, cookieBase); res.clearCookie(cookieNames.linkUser, cookieBase); res.redirect('/?connected=gmail');
    syncUser(user.id).catch(console.error);
  } catch (error) { next(error); }
});
app.post('/auth/demo', (_req, res) => { if(process.env.DEMO_MODE!=='true')return res.status(404).json({error:'Not found'});res.cookie(cookieNames.session, signSession(demoUser.id), { ...cookieBase, maxAge: 30 * 86400_000 }); res.json({ ok: true }); });
app.post('/auth/logout', (_req, res) => { res.clearCookie(cookieNames.session, cookieBase); res.json({ ok: true }); });

app.get('/api/dashboard', requireUser, async (_req, res) => {
  const id = res.locals.userId; const user = await getUser(id); if (!user) return res.status(404).json({ error: 'User not found' });
  const [signals, tasks, connections, brief, settings, chatgpt] = await Promise.all([getSignals(id), getTasks(id), getConnections(id), getBrief(id), getSettings(id), getChatGPTConnection(id)]);
  const data: DashboardData = { user, mode: id === demoUser.id ? 'demo' : 'live', greeting: new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening',
    brief: brief || { headline: 'Your orbit is quiet.', narrative: 'Connect a source or add a task to begin.', wins: [], watchouts: [], generatedAt: new Date().toISOString() }, signals, tasks, connections, settings,
    system: { storage: pool ? 'postgres' : 'memory', persistent: !!pool, aiProviders: aiProviders(!!chatgpt?.encryptedCredentials), chatgpt:{connected:!!chatgpt?.encryptedCredentials,email:chatgpt?.email,hostId:chatgpt?.hostId} },
    stats: { needsYou: signals.filter(s => s.category === 'action' && s.priority !== 'later').length, waitingOn: signals.filter(s => s.category === 'waiting').length, cleared: tasks.filter(t => t.status === 'done').length, noiseFiltered: signals.filter(s => s.category === 'noise').length + (id === demoUser.id ? 43 : 0) } };
  res.json(data);
});
app.post('/api/tasks', requireUser, async (req, res) => res.status(201).json(await createTask(res.locals.userId, req.body)));
app.patch('/api/tasks/:id', requireUser, async (req, res) => { const task = await updateTask(res.locals.userId, String(req.params.id), req.body.status); task ? res.json(task) : res.status(404).json({ error: 'Task not found' }); });
app.post('/api/sync', requireUser, async (_req, res) => { try { const result=await syncUser(res.locals.userId); res.json({ ok:true,syncedAt:new Date().toISOString(),...result }); } catch (e) { console.error(e);res.status(502).json({error:e instanceof Error?e.message:'Sync failed'}); } });
app.patch('/api/settings',requireUser,async(req,res)=>{const id=res.locals.userId;const [current,chatgpt]=await Promise.all([getSettings(id),getChatGPTConnection(id)]);const provider=(req.body?.aiProvider===undefined?current.aiProvider:String(req.body.aiProvider)) as AiProvider;const option=aiProviders(!!chatgpt?.encryptedCredentials).find(item=>item.id===provider);if(!option||!option.configured)return res.status(400).json({error:'That AI provider is not configured on this installation'});const list=(value:unknown,fallback:string[])=>Array.isArray(value)?value.map(item=>String(item).trim().toLowerCase()).filter(Boolean).slice(0,100):fallback;const clamp=(value:unknown,fallback:number,min:number,max:number)=>Math.min(max,Math.max(min,Number.isFinite(Number(value))?Number(value):fallback));const settings={...current,aiProvider:provider,aiInputChars:clamp(req.body?.aiInputChars,current.aiInputChars,200,8000),chatgptModel:req.body?.chatgptModel===undefined?current.chatgptModel:String(req.body.chatgptModel).trim().slice(0,120)||undefined,autoSync:req.body?.autoSync===undefined?current.autoSync:req.body.autoSync===true,syncIntervalMinutes:clamp(req.body?.syncIntervalMinutes,current.syncIntervalMinutes,30,1440),syncLookbackDays:clamp(req.body?.syncLookbackDays,current.syncLookbackDays,1,90),initialSyncLookbackDays:clamp(req.body?.initialSyncLookbackDays,current.initialSyncLookbackDays,1,365),syncMaxMessages:clamp(req.body?.syncMaxMessages,current.syncMaxMessages,1,100),initialSyncMaxMessages:clamp(req.body?.initialSyncMaxMessages,current.initialSyncMaxMessages,1,100),excludePromotions:req.body?.excludePromotions===undefined?current.excludePromotions:req.body.excludePromotions===true,excludeSocial:req.body?.excludeSocial===undefined?current.excludeSocial:req.body.excludeSocial===true,excludeForums:req.body?.excludeForums===undefined?current.excludeForums:req.body.excludeForums===true,blockedSenders:list(req.body?.blockedSenders,current.blockedSenders),blockedKeywords:list(req.body?.blockedKeywords,current.blockedKeywords)};res.json(await saveSettings(id,settings));});
app.post('/api/ask',requireUser,async(req,res)=>{try{const question=String(req.body?.question||'').trim();if(!question||question.length>600)return res.status(400).json({error:'Ask a question between 1 and 600 characters'});const [signals,tasks,settings]=await Promise.all([getSignals(res.locals.userId),getTasks(res.locals.userId),getSettings(res.locals.userId)]);res.json({answer:await answerQuestion(question,signals,tasks,settings,res.locals.userId)});}catch(e){console.error(e);res.status(502).json({error:'Ask Orbit could not use the selected AI provider. Check Settings or switch to Private rules, then try again.'});}});
app.post('/api/data/reprocess',requireUser,async(req,res)=>{if(req.body?.confirmation!=='REPROCESS')return res.status(400).json({error:'Type REPROCESS to confirm'});try{const removed=await clearDerivedData(res.locals.userId);const synced=await syncUser(res.locals.userId);res.json({ok:true,removed,synced});}catch(e){console.error(e);res.status(502).json({error:`Stored derived data was cleared, but the new sync failed. ${e instanceof Error?e.message:'Check connection settings and retry.'}`});}});
app.get('/api/chatgpt/setup',requireUser,async(_req,res,next)=>{try{res.json(await chatGPTSetup(res.locals.userId));}catch(e){next(e);}});
app.post('/api/chatgpt/import',requireUser,async(req,res)=>{try{res.json(await importChatGPTCredentials(res.locals.userId,req.body));}catch(e){console.error(e);res.status(400).json({error:e instanceof Error?e.message:'Could not import ChatGPT credentials'});}});
app.get('/api/chatgpt/models',requireUser,async(_req,res)=>{try{res.json({models:await chatGPTModels(res.locals.userId)});}catch(e){console.error(e);res.status(400).json({error:e instanceof Error?e.message:'Could not load ChatGPT models'});}});
app.delete('/api/chatgpt',requireUser,async(_req,res,next)=>{try{await disconnectChatGPT(res.locals.userId);const settings=await getSettings(res.locals.userId);if(settings.aiProvider==='chatgpt-subscription')await saveSettings(res.locals.userId,{...settings,aiProvider:'rules',chatgptModel:undefined});res.status(204).end();}catch(e){next(e);}});
app.get('/api/account/export',requireUser,async(_req,res)=>{const id=res.locals.userId;const [user,connections,signals,tasks,brief,settings]=await Promise.all([getUser(id),getConnections(id),getSignals(id),getTasks(id),getBrief(id),getSettings(id)]);res.setHeader('Content-Disposition','attachment; filename="orbit-export.json"');res.json({exportedAt:new Date().toISOString(),user,connections:connections.map(({encryptedTokens,...connection})=>connection),signals,tasks,brief,settings});});
app.delete('/api/connections/:id',requireUser,async(req,res,next)=>{try{const connections=await getConnections(res.locals.userId);const connection=connections.find(c=>c.id===String(req.params.id));if(!connection)return res.status(404).json({error:'Connection not found'});if(connection.encryptedTokens){const tokens=decrypt<{access_token?:string;refresh_token?:string}>(connection.encryptedTokens);const token=tokens.refresh_token||tokens.access_token;if(token)await oauthClient().revokeToken(token).catch(()=>undefined);}await deleteConnection(res.locals.userId,connection.id);res.status(204).end();}catch(e){next(e);}});
app.delete('/api/account',requireUser,async(req,res,next)=>{try{if(req.body?.confirmation!=='DELETE')return res.status(400).json({error:'Type DELETE to confirm'});const connections=await getConnections(res.locals.userId);for(const connection of connections){if(!connection.encryptedTokens)continue;const tokens=decrypt<{access_token?:string;refresh_token?:string}>(connection.encryptedTokens);const token=tokens.refresh_token||tokens.access_token;if(token)await oauthClient().revokeToken(token).catch(()=>undefined);}await disconnectChatGPT(res.locals.userId);await deleteUser(res.locals.userId);res.clearCookie(cookieNames.session,cookieBase);res.status(204).end();}catch(e){next(e);}});

if (production) { const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'); app.use(express.static(root)); app.get('/*splat', (_req, res) => res.sendFile(path.join(root, 'index.html'))); }
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { console.error(error); res.status(500).json({ error: production ? 'Unexpected error' : error instanceof Error ? error.message : 'Unexpected error' }); });

await initStore();
await pruneOldSignals();
cron.schedule(process.env.SYNC_CRON || '*/5 * * * *', async () => { if (!pool) return; const { rows } = await pool.query("SELECT DISTINCT user_id FROM connections WHERE provider='gmail' AND status IN ('connected','error')"); for (const row of rows){const [settings,connections]=await Promise.all([getSettings(row.user_id),getConnections(row.user_id)]);if(!settings.autoSync)continue;const gmail=connections.filter(connection=>connection.provider==='gmail');const due=gmail.some(connection=>{const last=connection.lastSyncAttemptAt||connection.lastSyncedAt;return!last||Date.now()-new Date(last).getTime()>=settings.syncIntervalMinutes*60_000});if(due)await syncUser(row.user_id).catch(console.error);} });
cron.schedule('17 3 * * *', () => pruneOldSignals().catch(console.error));
app.listen(port, () => console.log(`Orbit listening on http://localhost:${port}`));
