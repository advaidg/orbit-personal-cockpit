import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { startApp, type TestServer } from './httpApp.js';
import { buildSmtpUrl, setSetupVerifiers } from '../server/api/setup.js';
import { clearSetting, loadInstallationConfig, resetInstallationConfig, saveSetting, setting, settingSource } from '../server/installationConfig.js';
import { aiProviders } from '../server/ai.js';
import { setTelegramApi, getBotToken, type TelegramApi } from '../server/telegram/api.js';
import { telegramConfigured } from '../server/telegram/poller.js';
import { pactLimits } from '../server/pacts/config.js';
import { collectionRowsForTests } from './setupRows.js';
import { createNotifier } from '../server/notify.js';
import { saveAgentSettings } from '../server/agent/settings.js';

const savedEnv = { ...process.env };
let server: TestServer | undefined;
let restoreVerifiers: (() => void) | undefined;
let restoreTelegram: (() => void) | undefined;
beforeEach(async () => { await resetStorage(); });
afterEach(() => {
  restoreVerifiers?.();
  restoreTelegram?.();
  restoreVerifiers = restoreTelegram = undefined;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
afterAll(async () => { await server?.close(); });

const TOKEN = '123456789:AAEhBP0av28-aBcDeFgHiJkLmNoPqRsTuVw';
const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function app() {
  const owner = await freshOwner('Alex');
  process.env.OWNER_EMAIL = owner.email;
  await server?.close();
  server = await startApp(owner.id);
  return { owner, url: server.url };
}

function fakeTelegram(accepts: (token: string) => boolean = () => true): TelegramApi {
  return { async send() {}, async answerCallback() {}, async getUpdates() { return []; }, async botUsername() { return getBotToken() ? 'orbit_helper_bot' : undefined; }, async verifyToken(token) { if (!accepts(token)) throw new Error('Unauthorized'); return { username: 'orbit_helper_bot' }; } };
}

describe(`installation settings (${storageMode})`, () => {
  it('stores values encrypted, prefers them over the environment, and falls back when removed', async () => {
    const { owner } = await app();
    process.env.OPENAI_API_KEY = 'sk-from-environment-0000000000';
    expect(setting('OPENAI_API_KEY')).toBe('sk-from-environment-0000000000');
    expect(settingSource('OPENAI_API_KEY')).toBe('env');
    await saveSetting(owner.id, 'OPENAI_API_KEY', 'sk-from-the-screen-1111111111');
    expect(setting('OPENAI_API_KEY')).toBe('sk-from-the-screen-1111111111');
    expect(settingSource('OPENAI_API_KEY')).toBe('ui');
    const stored = JSON.stringify(await collectionRowsForTests());
    expect(stored).not.toContain('sk-from-the-screen');
    await clearSetting(owner.id, 'OPENAI_API_KEY');
    expect(setting('OPENAI_API_KEY')).toBe('sk-from-environment-0000000000');
  });

  it('survives a restart when the database is persistent', async () => {
    if (storageMode === 'memory') return;
    const { owner } = await app();
    await saveSetting(owner.id, 'DIGEST_TO', 'me@example.test');
    resetInstallationConfig();
    expect(setting('DIGEST_TO')).toBeUndefined();
    await loadInstallationConfig();
    expect(setting('DIGEST_TO')).toBe('me@example.test');
  });

  it('does not apply the saved value to an explicit environment object', () => {
    expect(setting('FEDERATION_ENABLED', { FEDERATION_ENABLED: 'true' })).toBe('true');
  });
});

describe(`Telegram setup (${storageMode})`, () => {
  it('validates the token, starts using it at once, and never gives it back', async () => {
    const { url } = await app();
    restoreTelegram = setTelegramApi(fakeTelegram((token) => token === TOKEN));
    expect((await fetch(`${url}/api/setup/telegram`, json('PUT', { token: 'not a token' }))).status).toBe(400);
    const rejected = await fetch(`${url}/api/setup/telegram`, json('PUT', { token: '987654321:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' }));
    expect(rejected.status).toBe(400);
    expect(telegramConfigured()).toBe(false);
    const ok = await fetch(`${url}/api/setup/telegram`, json('PUT', { token: TOKEN }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ bot: 'orbit_helper_bot' });
    expect(telegramConfigured()).toBe(true);
    const status = await (await fetch(`${url}/api/setup`)).text();
    expect(status).not.toContain(TOKEN);
    expect(JSON.parse(status).telegram).toMatchObject({ configured: true, source: 'ui', linked: false, bot: 'orbit_helper_bot' });
  });

  it('hands out a one-tap link to the bot, then disconnects cleanly', async () => {
    const { url } = await app();
    restoreTelegram = setTelegramApi(fakeTelegram());
    await fetch(`${url}/api/setup/telegram`, json('PUT', { token: TOKEN }));
    const link = await (await fetch(`${url}/api/channels/telegram/link`, json('POST'))).json();
    expect(link.url).toBe(`https://t.me/orbit_helper_bot?start=${link.code}`);
    expect((await fetch(`${url}/api/setup/telegram`, json('DELETE'))).status).toBe(204);
    expect(telegramConfigured()).toBe(false);
    expect((await fetch(`${url}/api/channels/telegram/link`, json('POST'))).status).toBe(400);
  });
});

describe(`email setup (${storageMode})`, () => {
  const form = { host: 'smtp.example.com', port: 587, secure: false, user: 'me@example.com', password: 'p@ss:w/rd', from: 'orbit@example.com', to: 'me@example.com' };

  it('builds a safe SMTP address from the form', () => {
    expect(buildSmtpUrl(form)).toBe('smtp://me%40example.com:p%40ss%3Aw%2Frd@smtp.example.com:587');
    expect(buildSmtpUrl({ ...form, secure: true, user: undefined })).toBe('smtps://smtp.example.com:587');
  });

  it('only saves after the server accepts the login, and never returns the password', async () => {
    const { url } = await app();
    restoreVerifiers = setSetupVerifiers({ smtp: async (smtpUrl) => { if (!smtpUrl.includes('p%40ss')) throw new Error('535 auth failed'); } });
    const bad = await fetch(`${url}/api/setup/email`, json('PUT', { ...form, password: 'wrong' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Could not sign in/);
    expect(setting('SMTP_URL')).toBeUndefined();
    expect((await fetch(`${url}/api/setup/email`, json('PUT', { ...form, host: 'bad host!' }))).status).toBe(400);
    expect((await fetch(`${url}/api/setup/email`, json('PUT', form))).status).toBe(200);
    const text = await (await fetch(`${url}/api/setup`)).text();
    expect(text).not.toContain('p%40ss');
    expect(text).not.toContain('p@ss');
    expect(JSON.parse(text).email).toMatchObject({ configured: true, source: 'ui', host: 'smtp.example.com', user: 'me@example.com', from: 'orbit@example.com', to: 'me@example.com' });
  });

  it('uses the saved server for digests and falls back to nothing when removed', async () => {
    const { owner, url } = await app();
    restoreVerifiers = setSetupVerifiers({ smtp: async () => undefined });
    await fetch(`${url}/api/setup/email`, json('PUT', form));
    await saveAgentSettings(owner.id, { channels: { email: true } });
    const sent: string[] = [];
    const notifier = createNotifier({ sendEmail: async (to, subject) => { sent.push(`${to}|${subject}`); } });
    const results = await notifier.deliver(owner.id, { title: 'Hello', body: 'Body', kind: 'info' }, ['email']);
    expect(results[0].ok).toBe(true);
    expect(sent[0]).toBe('me@example.com|Orbit: Hello');
    await fetch(`${url}/api/setup/email`, json('DELETE'));
    expect(setting('SMTP_URL')).toBeUndefined();
    expect(setting('DIGEST_TO')).toBeUndefined();
  });
});

describe(`AI keys (${storageMode})`, () => {
  const key = 'sk-test-1234567890abcdefghij';

  it('verifies a key, makes the provider available at once, and hides it afterwards', async () => {
    const { url } = await app();
    delete process.env.OPENAI_API_KEY;
    expect(aiProviders(false).find((item) => item.id === 'openai')?.configured).toBe(false);
    restoreVerifiers = setSetupVerifiers({ probe: async (_provider, value) => ({ verdict: value === key ? 'ok' : 'rejected', models: [] }) });
    const rejected = await fetch(`${url}/api/setup/ai`, json('PUT', { provider: 'openai', apiKey: 'sk-wrong-1234567890abcdefghij' }));
    expect(rejected.status).toBe(400);
    expect(aiProviders(false).find((item) => item.id === 'openai')?.configured).toBe(false);
    const ok = await fetch(`${url}/api/setup/ai`, json('PUT', { provider: 'openai', apiKey: key, model: 'gpt-4.1-mini' }));
    expect(ok.status).toBe(200);
    expect(aiProviders(false).find((item) => item.id === 'openai')?.configured).toBe(true);
    const text = await (await fetch(`${url}/api/setup`)).text();
    expect(text).not.toContain(key);
    expect(JSON.parse(text).ai.openai).toEqual({ configured: true, source: 'ui', model: 'gpt-4.1-mini' });
    expect((await fetch(`${url}/api/setup/ai/openai`, json('DELETE'))).status).toBe(204);
    expect(aiProviders(false).find((item) => item.id === 'openai')?.configured).toBe(false);
  });

  it('still saves when the provider cannot be reached, but says so', async () => {
    const { url } = await app();
    restoreVerifiers = setSetupVerifiers({ probe: async () => ({ verdict: 'unreachable', models: [] }) });
    const response = await (await fetch(`${url}/api/setup/ai`, json('PUT', { provider: 'anthropic', apiKey: key }))).json();
    expect(response.warning).toMatch(/could not reach/i);
    expect(setting('ANTHROPIC_API_KEY')).toBe(key);
  });

  it('configures OpenRouter, a local model or any compatible server, and validates the address', async () => {
    const { url } = await app();
    restoreVerifiers = setSetupVerifiers({ probe: async (_provider, value) => ({ verdict: value === 'bad-key' ? 'rejected' : 'ok', models: [] }) });
    expect((await fetch(`${url}/api/setup/ai`, json('PUT', { provider: 'compatible', baseUrl: 'ftp://nope', model: 'llama3' }))).status).toBe(400);
    const rejected = await fetch(`${url}/api/setup/ai`, json('PUT', { provider: 'compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o', apiKey: 'bad-key' }));
    expect(rejected.status).toBe(400);
    expect(setting('AI_BASE_URL')).toBeUndefined();
    const ok = await fetch(`${url}/api/setup/ai`, json('PUT', { provider: 'compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5', apiKey: 'or-key-1234567890' }));
    expect(ok.status).toBe(200);
    const provider = aiProviders(false).find((item) => item.id === 'openai-compatible')!;
    expect(provider).toMatchObject({ configured: true, external: true });
    const status = await (await fetch(`${url}/api/setup`)).text();
    expect(status).not.toContain('or-key-1234567890');
    expect(JSON.parse(status).ai.compatible).toMatchObject({ configured: true, baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' });
    expect((await fetch(`${url}/api/setup/ai`, json('PUT', { provider: 'mystery', apiKey: key }))).status).toBe(400);
    expect((await fetch(`${url}/api/setup/ai/mystery`, json('DELETE'))).status).toBe(404);
  });

  it('treats a local address as local and warns when a cloud server cannot reach it', async () => {
    const { url } = await app();
    restoreVerifiers = setSetupVerifiers({ probe: async () => ({ verdict: 'unreachable', models: [] }) });
    const response = await (await fetch(`${url}/api/setup/ai`, json('PUT', { provider: 'compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' }))).json();
    expect(response.warning).toMatch(/localhost|cloud/i);
    const provider = aiProviders(false).find((item) => item.id === 'openai-compatible')!;
    expect(provider).toMatchObject({ configured: true, external: false });
  });

  it('lists a key’s models without saving it, keeping the key out of the URL', async () => {
    const { url } = await app();
    const seen: Array<{ provider: string; key?: string; baseUrl?: string }> = [];
    restoreVerifiers = setSetupVerifiers({ probe: async (provider, value, baseUrl) => { seen.push({ provider, key: value, baseUrl }); return value === 'wrong' ? { verdict: 'rejected', models: [] } : { verdict: 'ok', models: ['model-a', 'model-b'] }; } });
    const ask = (body: object) => fetch(`${url}/api/setup/ai/models`, json('POST', body));
    const good = await (await ask({ provider: 'anthropic', apiKey: key })).json();
    expect(good.models).toEqual(['model-a', 'model-b']);
    expect(setting('ANTHROPIC_API_KEY')).toBeUndefined();
    expect((await ask({ provider: 'openai', apiKey: 'wrong' })).status).toBe(400);
    expect((await ask({ provider: 'openai' })).status).toBe(400);
    expect((await ask({ provider: 'compatible' })).status).toBe(400);
    expect((await ask({ provider: 'compatible', baseUrl: 'https://openrouter.ai/api/v1' })).status).toBe(200);
    expect(seen.at(-1)).toEqual({ provider: 'compatible', key: undefined, baseUrl: 'https://openrouter.ai/api/v1' });
    expect((await ask({ provider: 'nope' })).status).toBe(400);
  });

  it('reports ChatGPT plan state without exposing credentials', async () => {
    const { url } = await app();
    const status = await (await fetch(`${url}/api/setup`)).json();
    expect(status.ai.chatgpt).toEqual({ connected: false });
  });
});

describe(`Orbit-to-Orbit switch (${storageMode})`, () => {
  it('turns sharing on and off from the screen, with the public endpoint following at once', async () => {
    const { url } = await app();
    delete process.env.FEDERATION_ENABLED;
    expect(pactLimits().federationEnabled).toBe(false);
    expect((await fetch(`${url}/.well-known/orbit-pacts`)).status).toBe(404);
    const on = await fetch(`${url}/api/setup/federation`, json('PUT', { enabled: true }));
    expect(on.status).toBe(200);
    expect(pactLimits().federationEnabled).toBe(true);
    expect((await fetch(`${url}/.well-known/orbit-pacts`)).status).toBe(200);
    await fetch(`${url}/api/setup/federation`, json('PUT', { enabled: false }));
    expect((await fetch(`${url}/.well-known/orbit-pacts`)).status).toBe(404);
  });

  it('explains what to fix instead of switching on when the deployment cannot support it', async () => {
    const { url } = await app();
    process.env.NODE_ENV = 'production';
    process.env.APP_URL = 'http://insecure.example.test';
    const refused = await fetch(`${url}/api/setup/federation`, json('PUT', { enabled: true }));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/https/);
    delete process.env.OWNER_EMAIL;
    process.env.APP_URL = 'https://ok.example.test';
    expect((await (await fetch(`${url}/api/setup/federation`, json('PUT', { enabled: true }))).json()).error).toMatch(/OWNER_EMAIL/);
  });
});

describe('setup is never reachable from the sample workspace', () => {
  it('rejects the demo user on every setup route', async () => {
    await resetStorage();
    const express = (await import('express')).default;
    const { forbidDemo } = await import('../server/api/http.js');
    const { setupRouter } = await import('../server/api/setup.js');
    const a = express();
    a.use(express.json());
    a.use('/api/setup', (_req, res, next) => { res.locals.userId = 'demo-user'; next(); }, forbidDemo, setupRouter);
    const srv = await new Promise<import('node:http').Server>((resolve) => { const s = a.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = (srv.address() as import('node:net').AddressInfo).port;
    try {
      for (const [method, path] of [['GET', ''], ['PUT', '/telegram'], ['PUT', '/email'], ['PUT', '/ai'], ['PUT', '/federation'], ['DELETE', '/telegram']] as const) {
        expect((await fetch(`http://127.0.0.1:${port}/api/setup${path}`, json(method, method === 'GET' ? undefined : {}))).status, `${method} ${path}`).toBe(403);
      }
    } finally { await new Promise((resolve) => srv.close(resolve)); }
  });
});
