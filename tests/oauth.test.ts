import crypto from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { startApp, type TestServer } from './httpApp.js';
import { PendingFlows } from '../server/oauth/pending.js';
import { beginChatGPTAuth, finishChatGPTAuth, resetChatGptFlows, setChatGptHooks, type Exchange } from '../server/oauth/chatgptAuth.js';
import { beginOpenRouterAuth, finishOpenRouterAuth, resetOpenRouterFlows, setOpenRouterExchange } from '../server/oauth/openrouterAuth.js';
import { importChatGPTCredentials, chatGPTSetup, type ChatGPTCredentials } from '../server/chatgpt.js';
import { setting } from '../server/installationConfig.js';
import { collectionRowsForTests } from './setupRows.js';

const savedEnv = { ...process.env };
let server: TestServer | undefined;
let restore: Array<() => void> = [];
beforeEach(async () => { await resetStorage(); resetChatGptFlows(); resetOpenRouterFlows(); process.env.APP_URL = 'https://orbit.example.test'; });
afterEach(() => {
  restore.forEach((fn) => fn());
  restore = [];
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
afterAll(async () => { await server?.close(); });

describe('pending sign-in state', () => {
  it('expires, is single-use, and is bounded', () => {
    const flows = new PendingFlows<string>();
    flows.put('a', 'one', 0);
    expect(flows.peek('a', 5 * 60_000)).toBe('one');
    expect(flows.take('a', 5 * 60_000)).toBe('one');
    expect(flows.take('a', 5 * 60_000)).toBeUndefined();
    flows.put('b', 'two', 0);
    expect(flows.peek('b', 11 * 60_000)).toBeUndefined();
    for (let index = 0; index < 80; index += 1) flows.put(`k${index}`, 'x', 0);
    expect(flows.peek('k0', 1)).toBeUndefined();
    expect(flows.peek('k79', 1)).toBe('x');
  });
});

describe(`ChatGPT plan sign-in without a command line (${storageMode})`, () => {
  const seen: Array<{ code: string; redirectUri: string; clientId: string; verifier: string }> = [];
  const exchange: Exchange = {
    async token(input) { seen.push(input); return { id_token: 'id.token.jwt', access_token: 'access-abc', refresh_token: 'refresh-xyz', token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' }; },
    async identity() { return { subject: 'user-123', email: 'me@example.test' }; }
  };
  const imported: ChatGPTCredentials[] = [];
  const hooks = () => restore.push(setChatGptHooks({ exchange, importer: async (_userId, bundle) => { imported.push(bundle as ChatGPTCredentials); return { connected: true, email: (bundle as ChatGPTCredentials).email }; } }));
  beforeEach(() => { seen.length = 0; imported.length = 0; });

  const callbackFor = (redirectUri: string, state: string, extra: Record<string, string> = { code: 'one-time-code', client_id: 'client_issued_by_openai' }) => `${redirectUri}?${new URLSearchParams({ state, ...extra })}`;
  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

  it('builds a sign-in address with PKCE, a loopback redirect and this installation’s id', async () => {
    const owner = await freshOwner();
    const { url, redirectUri } = await beginChatGPTAuth(owner.id);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    const params = Object.fromEntries(parsed.searchParams);
    expect(params).toMatchObject({ response_type: 'code', client_id: 'dynamic_agent_client', code_challenge_method: 'S256', agent_name_hint: 'Orbit', resource: 'https://api.openai.com/v1' });
    expect(params.scope.split(' ')).toContain('chatgpt.tokens.use.direct');
    expect(params.ext_agent_host_id).toBe((await chatGPTSetup(owner.id)).hostId);
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d{5}\/auth\/callback$/);
    expect(params.redirect_uri).toBe(redirectUri);
    expect(Number(new URL(redirectUri).port)).toBeGreaterThanOrEqual(49152);
  });

  it('finishes from the pasted address: checks the PKCE verifier, builds the bundle and imports it', async () => {
    hooks();
    const owner = await freshOwner();
    const started = await beginChatGPTAuth(owner.id);
    const result = await finishChatGPTAuth(owner.id, callbackFor(started.redirectUri, stateOf(started.url)));
    expect(result.email).toBe('me@example.test');
    expect(seen).toHaveLength(1);
    expect(crypto.createHash('sha256').update(seen[0].verifier).digest('base64url')).toBe(new URL(started.url).searchParams.get('code_challenge'));
    expect(seen[0]).toMatchObject({ code: 'one-time-code', clientId: 'client_issued_by_openai', redirectUri: started.redirectUri });
    expect(imported[0]).toMatchObject({ subject: 'user-123', client_id: 'client_issued_by_openai', ext_agent_host_id: (await chatGPTSetup(owner.id)).hostId, refresh_token: 'refresh-xyz' });
    expect(imported[0].scopes).toContain('chatgpt.tokens.use.direct');
  });

  it('accepts a code only once', async () => {
    hooks();
    const owner = await freshOwner();
    const started = await beginChatGPTAuth(owner.id);
    const pasted = callbackFor(started.redirectUri, stateOf(started.url));
    await finishChatGPTAuth(owner.id, pasted);
    await expect(finishChatGPTAuth(owner.id, pasted)).rejects.toThrow(/expired or was never started/);
    expect(seen).toHaveLength(1);
  });

  it.each([
    ['an address from some other site', (r: string, s: string) => `https://evil.example/auth/callback?state=${s}&code=c&client_id=x`, /not from this sign-in/],
    ['a different loopback port', (r: string, s: string) => `http://127.0.0.1:1/auth/callback?state=${s}&code=c&client_id=x`, /not from this sign-in/],
    ['a different path', (r: string, s: string) => `${new URL(r).origin}/steal?state=${s}&code=c&client_id=x`, /not from this sign-in/],
    ['text that is not an address', () => 'just some words', /not a web address/],
    ['the wrong state', (r: string) => `${r}?state=forged&code=c&client_id=x`, /different sign-in attempt/],
    ['a denial from OpenAI', (r: string, s: string) => `${r}?state=${s}&error=access_denied`, /did not complete the sign-in/],
    ['no code', (r: string, s: string) => `${r}?state=${s}&client_id=x`, /did not return what Orbit needs/],
    ['the placeholder client id', (r: string, s: string) => `${r}?state=${s}&code=c&client_id=dynamic_agent_client`, /did not return what Orbit needs/]
  ])('rejects %s and does not contact OpenAI', async (_label, build, message) => {
    hooks();
    const owner = await freshOwner();
    const started = await beginChatGPTAuth(owner.id);
    await expect(finishChatGPTAuth(owner.id, build(started.redirectUri, stateOf(started.url)))).rejects.toThrow(message);
    expect(seen).toHaveLength(0);
    expect(imported).toHaveLength(0);
  });

  it('refuses a sign-in that did not grant plan usage', async () => {
    restore.push(setChatGptHooks({ exchange: { ...exchange, token: async () => ({ id_token: 'x', access_token: 'a', refresh_token: 'r', scope: 'openid' }) }, importer: async () => ({ connected: true, email: 'x' }) }));
    const owner = await freshOwner();
    const started = await beginChatGPTAuth(owner.id);
    await expect(finishChatGPTAuth(owner.id, callbackFor(started.redirectUri, stateOf(started.url)))).rejects.toThrow(/not authorized/);
  });

  it('keeps one owner’s attempt away from another', async () => {
    hooks();
    const a = await freshOwner('a');
    const b = await freshOwner('b');
    const started = await beginChatGPTAuth(a.id);
    await expect(finishChatGPTAuth(b.id, callbackFor(started.redirectUri, stateOf(started.url)))).rejects.toThrow(/expired or was never started/);
  });

  it('stores nothing but the encrypted connection when the real importer runs', async () => {
    const owner = await freshOwner();
    const { hostId } = await chatGPTSetup(owner.id);
    const bundle: ChatGPTCredentials = { email: 'me@example.test', issuer: 'https://auth.openai.com', subject: 's', client_id: 'c', ext_agent_host_id: hostId, id_token: 'i', access_token: 'secret-access', refresh_token: 'secret-refresh', token_type: 'Bearer', expires_in: 3600, scopes: ['chatgpt.tokens.use.direct'], saved_at: new Date().toISOString() };
    await expect(importChatGPTCredentials(owner.id, { ...bundle, ext_agent_host_id: 'urn:uuid:other' }, async () => ({ subject: 's', email: 'me@example.test' }))).rejects.toThrow(/does not match this Orbit installation/);
    expect(await importChatGPTCredentials(owner.id, bundle, async () => ({ subject: 's', email: 'me@example.test' }))).toEqual({ connected: true, email: 'me@example.test' });
    expect((await chatGPTSetup(owner.id)).connected).toBe(true);
  });

  it('works through the owner API end to end', async () => {
    hooks();
    const owner = await freshOwner();
    server = await startApp(owner.id);
    const post = (path: string, body?: unknown) => fetch(`${server!.url}/api/setup${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const started = await (await post('/chatgpt/start')).json();
    expect(started.url).toContain('auth.openai.com');
    expect((await post('/chatgpt/finish', { url: 'nope-nope-nope' })).status).toBe(400);
    const ok = await post('/chatgpt/finish', { url: callbackFor(started.redirectUri, stateOf(started.url)) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ email: 'me@example.test' });
  });
});

describe(`OpenRouter one-click connect (${storageMode})`, () => {
  it('sends the owner to OpenRouter with PKCE and a callback on this installation', async () => {
    const owner = await freshOwner();
    const { url } = beginOpenRouterAuth(owner.id);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://openrouter.ai/auth');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(parsed.searchParams.get('callback_url')!);
    expect(callback.origin + callback.pathname).toBe('https://orbit.example.test/api/setup/openrouter/callback');
    expect(callback.searchParams.get('s')).toBeTruthy();
  });

  it('trades the code for a key on the server, stores it encrypted, and refuses replays and strangers', async () => {
    const owner = await freshOwner();
    const calls: Array<{ code: string; verifier: string }> = [];
    restore.push(setOpenRouterExchange(async (code, verifier) => { calls.push({ code, verifier }); return 'sk-or-v1-secretsecretsecret'; }));
    const { url } = beginOpenRouterAuth(owner.id);
    const parsed = new URL(url);
    const state = new URL(parsed.searchParams.get('callback_url')!).searchParams.get('s')!;
    await expect(finishOpenRouterAuth(owner.id, { code: 'abc', s: 'forged' })).rejects.toThrow(/expired or was not started/);
    await finishOpenRouterAuth(owner.id, { code: 'abc', s: state });
    expect(crypto.createHash('sha256').update(calls[0].verifier).digest('base64url')).toBe(parsed.searchParams.get('code_challenge'));
    expect(setting('AI_COMPATIBLE_API_KEY')).toBe('sk-or-v1-secretsecretsecret');
    expect(setting('AI_BASE_URL')).toBe('https://openrouter.ai/api/v1');
    expect(JSON.stringify(await collectionRowsForTests())).not.toContain('secretsecret');
    await expect(finishOpenRouterAuth(owner.id, { code: 'abc', s: state })).rejects.toThrow(/expired or was not started/);
    const other = await freshOwner('other');
    const second = beginOpenRouterAuth(owner.id);
    const secondState = new URL(new URL(second.url).searchParams.get('callback_url')!).searchParams.get('s')!;
    await expect(finishOpenRouterAuth(other.id, { code: 'abc', s: secondState })).rejects.toThrow(/expired or was not started/);
  });

  it('redirects back to the app after the callback and never puts the key in the redirect', async () => {
    const owner = await freshOwner();
    server = await startApp(owner.id);
    restore.push(setOpenRouterExchange(async () => 'sk-or-v1-secretsecretsecret'));
    const { url } = await (await fetch(`${server.url}/api/setup/openrouter/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    const state = new URL(new URL(url).searchParams.get('callback_url')!).searchParams.get('s')!;
    const ok = await fetch(`${server.url}/api/setup/openrouter/callback?code=abc&s=${state}`, { redirect: 'manual' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/?connected=openrouter#/connections');
    expect(ok.headers.get('location')).not.toContain('secret');
    const bad = await fetch(`${server.url}/api/setup/openrouter/callback?code=abc&s=forged`, { redirect: 'manual' });
    expect(bad.status).toBe(303);
    expect(decodeURIComponent(bad.headers.get('location')!)).toMatch(/setup_error=.*expired/);
  });
});
