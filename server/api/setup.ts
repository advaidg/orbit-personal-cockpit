import express from 'express';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { selectedProvider } from '../ai.js';
import { ActionableError, redact } from '../diagnostics.js';
import { clearSetting, saveSetting, setting, settingSource, settingsPersist, type ManagedKey } from '../installationConfig.js';
import { getUser, getSettings } from '../store.js';
import { pactLimits } from '../pacts/config.js';
import { getBotToken, telegramApi } from '../telegram/api.js';
import { isLinked, unlink } from '../telegram/link.js';
import { handle, ownerId } from './http.js';

export const setupRouter = express.Router();

// ---- test seams: the real network calls, replaceable so setup can be tested without any account ----------------

export type SmtpVerifier = (url: string) => Promise<void>;
export type KeyVerifier = (provider: 'openai' | 'anthropic', key: string) => Promise<'ok' | 'rejected' | 'unreachable'>;

const realSmtpVerifier: SmtpVerifier = async (url) => {
  // Timeouts live in the transport options (the second argument of createTransport is for mail defaults).
  await nodemailer.createTransport({ url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 }).verify();
};

const realKeyVerifier: KeyVerifier = async (provider, key) => {
  const request: { url: string; headers: Record<string, string> } = provider === 'openai'
    ? { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } }
    : { url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
  try {
    const response = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(10_000) });
    if (response.status === 401 || response.status === 403) return 'rejected';
    return response.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
};

let smtpVerifier = realSmtpVerifier;
let keyVerifier = realKeyVerifier;

/** Replaces the network checks (tests). Returns a function that restores the real ones. */
export function setSetupVerifiers(next: { smtp?: SmtpVerifier; keys?: KeyVerifier }): () => void {
  const previous = { smtpVerifier, keyVerifier };
  smtpVerifier = next.smtp ?? smtpVerifier;
  keyVerifier = next.keys ?? keyVerifier;
  return () => { smtpVerifier = previous.smtpVerifier; keyVerifier = previous.keyVerifier; };
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

const source = (key: ManagedKey) => settingSource(key);

/** Everything the screen needs to know about an SMTP URL except the credentials. */
function smtpSummary(): { host?: string; port?: string; secure?: boolean; user?: string } {
  const raw = setting('SMTP_URL');
  if (!raw) return {};
  try {
    const url = new URL(raw);
    return { host: url.hostname, port: url.port || undefined, secure: url.protocol === 'smtps:', user: url.username ? decodeURIComponent(url.username) : undefined };
  } catch {
    return {};
  }
}

export function buildSmtpUrl(input: { host: string; port: number; secure: boolean; user?: string; password?: string }): string {
  const auth = input.user ? `${encodeURIComponent(input.user)}${input.password ? `:${encodeURIComponent(input.password)}` : ''}@` : '';
  return `${input.secure ? 'smtps' : 'smtp'}://${auth}${input.host}:${input.port}`;
}

function federationState() {
  const base = process.env.APP_URL || '';
  const https = base.startsWith('https://');
  const production = process.env.NODE_ENV === 'production';
  const ownerConfigured = !!process.env.OWNER_EMAIL;
  const blocker = !ownerConfigured ? 'OWNER_EMAIL is not set on this installation, so other Orbits cannot find you.' : production && !https ? 'APP_URL must be an https address before other Orbits can reach you.' : undefined;
  return { enabled: pactLimits().federationEnabled, source: source('FEDERATION_ENABLED'), address: base || undefined, canEnable: !blocker, blocker };
}

const TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;
const MODEL = /^[\w.:/-]{1,80}$/;

// ---- status ---------------------------------------------------------------------------------------------------------

setupRouter.get('/', handle(async (_req, res) => {
  const userId = ownerId(res);
  const [linked, settings] = await Promise.all([isLinked(userId), getSettings(userId)]);
  const configured = !!getBotToken();
  res.json({
    persistent: settingsPersist(),
    telegram: { configured, source: source('TELEGRAM_BOT_TOKEN'), linked, bot: configured ? await telegramApi().botUsername() : undefined, inbound: pactLimits().telegramInbound },
    email: { configured: !!setting('SMTP_URL'), source: source('SMTP_URL'), ...smtpSummary(), from: setting('DIGEST_FROM'), to: setting('DIGEST_TO') },
    ai: {
      active: selectedProvider(settings.aiProvider),
      openai: { configured: !!setting('OPENAI_API_KEY'), source: source('OPENAI_API_KEY'), model: setting('OPENAI_MODEL') },
      anthropic: { configured: !!setting('ANTHROPIC_API_KEY'), source: source('ANTHROPIC_API_KEY'), model: setting('ANTHROPIC_MODEL') },
      compatible: { configured: !!setting('AI_BASE_URL') && !!setting('AI_COMPATIBLE_MODEL'), source: source('AI_BASE_URL'), baseUrl: setting('AI_BASE_URL'), model: setting('AI_COMPATIBLE_MODEL') }
    },
    federation: federationState()
  });
}));

// ---- Telegram ---------------------------------------------------------------------------------------------------------

setupRouter.put('/telegram', handle(async (req, res) => {
  const token = z.object({ token: z.string().trim().max(120) }).parse(req.body).token;
  if (!TOKEN.test(token)) throw new ActionableError('That does not look like a bot token.', { action: 'In Telegram, message @BotFather, send /newbot, and copy the whole token it gives you (numbers, a colon, then letters).', code: 'bad_token' });
  let bot: { username: string };
  try {
    bot = await telegramApi().verifyToken(token);
  } catch (error) {
    throw new ActionableError('Telegram did not accept that token.', { action: `Copy it again from @BotFather (or send /token there). ${redact(error instanceof Error ? error.message : '', 120)}`.trim(), code: 'bad_token', retryable: true });
  }
  await saveSetting(ownerId(res), 'TELEGRAM_BOT_TOKEN', token);
  res.json({ bot: bot.username });
}));

setupRouter.delete('/telegram', handle(async (_req, res) => {
  await unlink(ownerId(res));
  await clearSetting(ownerId(res), 'TELEGRAM_BOT_TOKEN');
  res.status(204).end();
}));

// ---- Email ------------------------------------------------------------------------------------------------------------

const emailBody = z.object({
  host: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9.-]+$/, 'Use just the server name, for example smtp.gmail.com'),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().max(200).optional(),
  password: z.string().max(500).optional(),
  from: z.string().trim().email().max(200),
  to: z.string().trim().email().max(200).optional().or(z.literal(''))
});

setupRouter.put('/email', handle(async (req, res) => {
  const input = emailBody.parse(req.body);
  const url = buildSmtpUrl(input);
  try {
    await smtpVerifier(url);
  } catch (error) {
    throw new ActionableError('Could not sign in to that email server.', { action: `Check the server, port, SSL setting and password (Gmail needs an app password). ${redact(error instanceof Error ? error.message : '', 160)}`.trim(), code: 'smtp_failed', retryable: true });
  }
  const userId = ownerId(res);
  await saveSetting(userId, 'SMTP_URL', url);
  await saveSetting(userId, 'DIGEST_FROM', input.from);
  if (input.to) await saveSetting(userId, 'DIGEST_TO', input.to);
  else await clearSetting(userId, 'DIGEST_TO');
  res.json({ ok: true });
}));

setupRouter.delete('/email', handle(async (_req, res) => {
  const userId = ownerId(res);
  for (const key of ['SMTP_URL', 'DIGEST_FROM', 'DIGEST_TO'] as const) await clearSetting(userId, key);
  res.status(204).end();
}));

// ---- AI providers -----------------------------------------------------------------------------------------------------

const aiBody = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('openai'), apiKey: z.string().trim().min(20).max(300).regex(/^\S+$/, 'A key has no spaces').optional(), model: z.string().trim().regex(MODEL).optional().or(z.literal('')) }),
  z.object({ provider: z.literal('anthropic'), apiKey: z.string().trim().min(20).max(300).regex(/^\S+$/, 'A key has no spaces').optional(), model: z.string().trim().regex(MODEL).optional().or(z.literal('')) }),
  z.object({ provider: z.literal('compatible'), baseUrl: z.string().trim().url().max(300).refine((value) => /^https?:\/\//.test(value), 'Use an http or https address'), model: z.string().trim().regex(MODEL), apiKey: z.string().trim().max(300).optional() })
]);

setupRouter.put('/ai', handle(async (req, res) => {
  const input = aiBody.parse(req.body);
  const userId = ownerId(res);
  let warning: string | undefined;
  if (input.provider === 'compatible') {
    await saveSetting(userId, 'AI_BASE_URL', input.baseUrl);
    await saveSetting(userId, 'AI_COMPATIBLE_MODEL', input.model);
    if (input.apiKey) await saveSetting(userId, 'AI_COMPATIBLE_API_KEY', input.apiKey);
    return res.json({ ok: true });
  }
  const keyName: ManagedKey = input.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const modelName: ManagedKey = input.provider === 'openai' ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL';
  const key = input.apiKey ?? setting(keyName);
  if (!key) throw new ActionableError('Paste your API key to continue.', { action: input.provider === 'openai' ? 'Create one at platform.openai.com/api-keys.' : 'Create one at console.anthropic.com/settings/keys.', code: 'key_required' });
  if (input.apiKey) {
    const verdict = await keyVerifier(input.provider, input.apiKey);
    if (verdict === 'rejected') throw new ActionableError('That provider rejected the key.', { action: 'Check you copied the whole key and that it is active.', code: 'bad_key', retryable: true });
    if (verdict === 'unreachable') warning = 'Saved, but I could not reach the provider to confirm the key. Try Ask Orbit to see if it works.';
    await saveSetting(userId, keyName, input.apiKey);
  }
  if (input.model) await saveSetting(userId, modelName, input.model);
  else if (input.model === '') await clearSetting(userId, modelName);
  res.json({ ok: true, warning });
}));

setupRouter.delete('/ai/:provider', handle(async (req, res) => {
  const userId = ownerId(res);
  const keys: Record<string, ManagedKey[]> = { openai: ['OPENAI_API_KEY', 'OPENAI_MODEL'], anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'], compatible: ['AI_BASE_URL', 'AI_COMPATIBLE_MODEL', 'AI_COMPATIBLE_API_KEY'] };
  const list = keys[String(req.params.provider)];
  if (!list) throw new ActionableError('Unknown provider.', { action: 'Use openai, anthropic or compatible.', code: 'not_found' });
  for (const key of list) await clearSetting(userId, key);
  res.status(204).end();
}));

// ---- Orbit-to-Orbit ---------------------------------------------------------------------------------------------------

setupRouter.put('/federation', handle(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  const state = federationState();
  if (enabled && !state.canEnable) throw new ActionableError(state.blocker ?? 'Orbit-to-Orbit cannot be turned on here.', { action: 'This is a deployment setting: fix it in your host’s variables, then try again.', code: 'federation_blocked' });
  if (enabled && !(await getUser(ownerId(res)))) throw new ActionableError('Sign in first.', { action: 'Sign in with Google once so Orbit knows who you are.', code: 'not_found' });
  await saveSetting(ownerId(res), 'FEDERATION_ENABLED', enabled ? 'true' : 'false');
  res.json(federationState());
}));
