import express from 'express';
import { setting } from '../installationConfig.js';
import { getBotToken } from '../telegram/api.js';
import { decrypt } from '../crypto.js';
import { diagnose, redact } from '../diagnostics.js';
import { cancelJob, getJob, listJobs } from '../jobs.js';
import { pool } from '../pool.js';
import { migrationStatus } from '../migrations.js';
import { gmailClient, canDraft, type GoogleTokens } from '../gmail.js';
import { calendarClient, canReadCalendar, canWriteCalendar } from '../calendar.js';
import { providerLimiter } from '../providerLimits.js';
import { aiProviders } from '../ai.js';
import { chatGPTModels } from '../chatgpt.js';
import { getChatGPTConnection, getConnections, getSettings } from '../store.js';
import { getAgentSettings } from '../agent/settings.js';
import { agentLimits } from '../agent/config.js';
import { lastTickAt } from '../scheduler.js';
import { ActionableError } from '../diagnostics.js';
import { handle, ownerId } from './http.js';

export const systemRouter = express.Router();

systemRouter.get('/jobs', handle(async (req, res) => res.json({ jobs: await listJobs(ownerId(res), { limit: Math.min(60, Number(req.query.limit) || 20) }) })));
systemRouter.get('/jobs/:id', handle(async (req, res) => {
  const job = await getJob(String(req.params.id), ownerId(res));
  if (!job) throw new ActionableError('That job no longer exists.', { action: 'Refresh and try again.', code: 'not_found' });
  res.json(job);
}));
systemRouter.post('/jobs/:id/cancel', handle(async (req, res) => {
  const job = await cancelJob(ownerId(res), String(req.params.id));
  if (!job) throw new ActionableError('That job no longer exists.', { action: 'Refresh and try again.', code: 'not_found' });
  res.json(job);
}));

interface Check {
  ok: boolean;
  latencyMs?: number;
  detail: string;
  action?: string;
}

async function timed(fn: () => Promise<string>): Promise<Check> {
  const started = Date.now();
  try {
    return { ok: true, latencyMs: Date.now() - started, detail: await fn() };
  } catch (error) {
    const diagnosis = diagnose(error);
    return { ok: false, latencyMs: Date.now() - started, detail: redact(`${diagnosis.message}`), action: diagnosis.action };
  }
}

/** Gmail, calendar, ChatGPT, database, queue and scheduler on one screen. Nothing here returns secrets or content. */
systemRouter.get('/diagnostics', handle(async (_req, res) => {
  const userId = ownerId(res);
  const [connections, settings, agentSettings, chatgpt, jobs] = await Promise.all([getConnections(userId), getSettings(userId), getAgentSettings(userId), getChatGPTConnection(userId), listJobs(userId, { limit: 50 })]);
  const day = Date.now() - 86_400_000;
  const recent = jobs.filter((job) => new Date(job.createdAt).getTime() >= day);
  const database = await timed(async () => {
    if (!pool) return 'Memory mode: data is lost on restart. Add DATABASE_URL for persistence.';
    await pool.query('SELECT 1');
    const migrations = await migrationStatus(pool);
    return `Postgres reachable. Schema version ${migrations.current} of ${migrations.latest}.`;
  });
  const limits = agentLimits();
  res.json({
    generatedAt: new Date().toISOString(),
    database: { ...database, storage: pool ? 'postgres' : 'memory', persistent: !!pool },
    connections: connections.filter((connection) => connection.provider === 'gmail' || connection.provider === 'calendar').map((connection) => {
      const tokens = connection.encryptedTokens ? decrypt<GoogleTokens>(connection.encryptedTokens) : undefined;
      return {
        id: connection.id, provider: connection.provider, label: connection.label, accountEmail: connection.accountEmail, status: connection.status, lastSyncedAt: connection.lastSyncedAt, lastSyncAttemptAt: connection.lastSyncAttemptAt, lastSyncError: connection.lastSyncError,
        canDraft: connection.provider === 'gmail' && tokens ? canDraft(tokens) : undefined, canWrite: connection.provider === 'calendar' && tokens ? canWriteCalendar(tokens) : undefined
      };
    }),
    chatgpt: { connected: !!chatgpt?.encryptedCredentials, email: chatgpt?.email, selected: settings.aiProvider === 'chatgpt-subscription' },
    ai: { provider: settings.aiProvider, providers: aiProviders(!!chatgpt?.encryptedCredentials).map(({ id, label, configured, external }) => ({ id, label, configured, external })) },
    queue: { queued: jobs.filter((job) => job.status === 'queued').length, running: jobs.filter((job) => job.status === 'running').length, failed24h: recent.filter((job) => job.status === 'failed').length, succeeded24h: recent.filter((job) => job.status === 'succeeded').length, recentFailures: recent.filter((job) => job.status === 'failed').slice(0, 5).map((job) => ({ id: job.id, kind: job.kind, error: job.error, at: job.finishedAt })) },
    scheduler: { lastTickAt: lastTickAt()?.toISOString() ?? null },
    agent: { enabled: limits.enabled, paused: agentSettings.paused, automationsKilled: agentSettings.automationsKilled },
    environment: { node: process.version, production: process.env.NODE_ENV === 'production', smtpConfigured: !!setting('SMTP_URL'), telegramConfigured: !!getBotToken() }
  });
}));

/** Live probes. These make one small provider call each, so they run only when the owner asks. */
systemRouter.post('/diagnostics/check', handle(async (_req, res) => {
  const userId = ownerId(res);
  const connections = (await getConnections(userId)).filter((connection) => (connection.provider === 'gmail' || connection.provider === 'calendar') && connection.encryptedTokens);
  const results: Record<string, Check> = {};
  results.database = await timed(async () => {
    if (!pool) return 'Memory mode.';
    await pool.query('SELECT 1');
    return 'Query succeeded.';
  });
  for (const connection of connections) {
    results[connection.id] = await timed(async () => {
      const tokens = decrypt<GoogleTokens>(connection.encryptedTokens!);
      if (connection.provider === 'gmail') {
        const profile = await providerLimiter.run('gmail', () => gmailClient(tokens).users.getProfile({ userId: 'me' }));
        return `Gmail reachable (${profile.data.emailAddress ? 'account verified' : 'no address returned'}).`;
      }
      if (!canReadCalendar(tokens)) throw new Error('Calendar authorization is missing the calendar.readonly scope');
      await providerLimiter.run('calendar', () => calendarClient(tokens).calendarList.list({ maxResults: 1 }));
      return 'Calendar reachable.';
    });
  }
  const chatgpt = await getChatGPTConnection(userId);
  if (chatgpt?.encryptedCredentials) results.chatgpt = await timed(async () => `ChatGPT plan reachable (${(await chatGPTModels(userId)).length} models available).`);
  res.json({ checkedAt: new Date().toISOString(), results });
}));
