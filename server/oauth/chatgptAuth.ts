import crypto from 'node:crypto';
import { ActionableError } from '../diagnostics.js';
import { chatGPTSetup, importChatGPTCredentials, type ChatGPTCredentials } from '../chatgpt.js';
import { publicBaseUrl } from '../pacts/config.js';
import { PendingFlows } from './pending.js';
import { newPkce, randomToken } from './pkce.js';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const DYNAMIC_CLIENT = 'dynamic_agent_client';

interface Attempt { state: string; nonce: string; verifier: string; redirectUri: string; hostId: string; automatic: boolean }
const attempts = new PendingFlows<Attempt>();
/** Lets the callback page find an attempt from its state value alone (the browser lands on 127.0.0.1, which carries no session cookie). */
const byState = new PendingFlows<string>();

export function resetChatGptFlows(): void {
  attempts.clear();
  byState.clear();
}

/** True when Orbit runs on the same computer as the browser, so the sign-in can come straight back to it. */
export function runsOnThisComputer(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(publicBaseUrl(env)).hostname);
  } catch {
    return false;
  }
}

export interface Exchange {
  /** Trades the one-time code for tokens (OpenAI's token endpoint). */
  token(input: { code: string; redirectUri: string; clientId: string; verifier: string }): Promise<Record<string, unknown>>;
  /** Verifies the identity token's signature, audience and nonce, and returns the person it names. */
  identity(idToken: string, clientId: string, nonce: string): Promise<{ subject: string; email?: string }>;
}

async function realToken(input: { code: string; redirectUri: string; clientId: string; verifier: string }): Promise<Record<string, unknown>> {
  const response = await fetch(`${CHATGPT_ISSUER}/api/accounts/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, client_id: input.clientId, code_verifier: input.verifier, resource: RESOURCE }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new ActionableError(`OpenAI would not complete the sign-in (${response.status}).`, { action: 'Start again — each sign-in link works once and for ten minutes.', code: 'chatgpt_exchange', retryable: true });
  return (await response.json()) as Record<string, unknown>;
}

async function realIdentity(idToken: string, clientId: string, nonce: string): Promise<{ subject: string; email?: string }> {
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  const metadata = (await (await fetch(`${CHATGPT_ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) })).json()) as { jwks_uri: string };
  const { payload } = await jwtVerify(idToken, createRemoteJWKSet(new URL(metadata.jwks_uri)), { issuer: CHATGPT_ISSUER, audience: clientId });
  // jose checks signature, issuer and audience; the nonce is ours to compare.
  if (payload.nonce !== nonce) throw new Error('OpenAI identity token does not match this sign-in');
  if (typeof payload.sub !== 'string') throw new Error('OpenAI identity token has no subject');
  return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined };
}

export const realExchange: Exchange = { token: realToken, identity: realIdentity };

interface Hooks { exchange: Exchange; importer: typeof importChatGPTCredentials }
let hooks: Hooks = { exchange: realExchange, importer: importChatGPTCredentials };

/** Replaces the network steps (tests). Returns a function that restores the real ones. */
export function setChatGptHooks(next: Partial<Hooks>): () => void {
  const previous = hooks;
  hooks = { ...hooks, ...next };
  return () => { hooks = previous; };
}

export interface Started {
  url: string;
  redirectUri: string;
  /** True when the browser will return to Orbit by itself; false when the owner has to paste the address back. */
  automatic: boolean;
}

/**
 * Step 1: build the OpenAI sign-in address. OpenAI only accepts a 127.0.0.1 redirect. When Orbit runs on the owner's
 * own computer that address is Orbit itself, so the browser returns here and everything finishes by itself. On a
 * cloud host nothing listens there: the browser shows "can't connect" and the owner pastes the address back.
 */
export async function beginChatGPTAuth(userId: string): Promise<Started> {
  const { hostId } = await chatGPTSetup(userId);
  const pkce = newPkce();
  const automatic = runsOnThisComputer();
  const port = automatic ? Number(process.env.PORT || 3000) : 49152 + crypto.randomInt(16000);
  const attempt: Attempt = { state: randomToken(), nonce: randomToken(), verifier: pkce.verifier, redirectUri: `http://127.0.0.1:${port}/auth/callback`, hostId, automatic };
  attempts.put(userId, attempt);
  byState.put(attempt.state, userId);
  const url = new URL(`${CHATGPT_ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: DYNAMIC_CLIENT, redirect_uri: attempt.redirectUri, scope: SCOPES.join(' '), resource: RESOURCE,
    state: attempt.state, nonce: attempt.nonce, code_challenge: pkce.challenge, code_challenge_method: 'S256', agent_name_hint: 'Orbit', ext_agent_host_id: hostId
  }).toString();
  return { url: url.toString(), redirectUri: attempt.redirectUri, automatic };
}

/** Step 2 (automatic): the browser came back to Orbit's own /auth/callback with the code in the query string. */
export async function finishChatGPTFromCallback(state: string, queryString: string): Promise<{ email?: string }> {
  const userId = state ? byState.peek(state) : undefined;
  const attempt = userId ? attempts.peek(userId) : undefined;
  if (!userId || !attempt || attempt.state !== state) throw new ActionableError('That sign-in expired or was never started.', { action: 'Go back to Orbit and press “Sign in with ChatGPT” again.', code: 'chatgpt_expired' });
  const result = await finishChatGPTAuth(userId, `${attempt.redirectUri}?${queryString}`);
  byState.take(state);
  return result;
}

/** Step 2: the owner pastes the address their browser ended on. Validate it strictly, then finish the sign-in. */
export async function finishChatGPTAuth(userId: string, pasted: string): Promise<{ email?: string }> {
  const { exchange, importer } = hooks;
  const attempt = attempts.peek(userId);
  if (!attempt) throw new ActionableError('That sign-in expired or was never started.', { action: 'Press “Sign in with ChatGPT” again.', code: 'chatgpt_expired' });
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new ActionableError('That is not a web address.', { action: 'Copy the whole address from your browser’s address bar after you approved the sign-in.', code: 'chatgpt_bad_url' });
  }
  const expected = new URL(attempt.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new ActionableError('That address is not from this sign-in.', { action: 'Use the address your browser showed right after approving — it starts with http://127.0.0.1.', code: 'chatgpt_bad_url' });
  if (url.searchParams.get('state') !== attempt.state) throw new ActionableError('That address belongs to a different sign-in attempt.', { action: 'Start again and use the newest window.', code: 'chatgpt_state' });
  const oauthError = url.searchParams.get('error');
  if (oauthError) throw new ActionableError(`OpenAI did not complete the sign-in (${oauthError.slice(0, 60)}).`, { action: 'Your plan may not be eligible for this preview. Try again, or use an API key instead.', code: 'chatgpt_denied' });
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client_id');
  if (!code || !clientId || clientId === DYNAMIC_CLIENT) throw new ActionableError('OpenAI did not return what Orbit needs.', { action: 'Start again.', code: 'chatgpt_bad_url' });

  attempts.take(userId); // a code can only be used once
  const token = await exchange.token({ code, redirectUri: attempt.redirectUri, clientId, verifier: attempt.verifier });
  const idToken = String(token.id_token ?? '');
  const identity = await exchange.identity(idToken, clientId, attempt.nonce);
  const granted = String(token.scope ?? '').split(' ').filter(Boolean);
  if (!granted.includes('chatgpt.tokens.use.direct')) throw new ActionableError('ChatGPT plan usage was not authorized.', { action: 'Your plan may not be eligible for this preview. Use an API key instead.', code: 'chatgpt_denied' });
  const bundle: ChatGPTCredentials = {
    email: identity.email ?? 'ChatGPT user', issuer: CHATGPT_ISSUER, subject: identity.subject, client_id: clientId, ext_agent_host_id: attempt.hostId, id_token: idToken,
    access_token: String(token.access_token ?? ''), refresh_token: String(token.refresh_token ?? ''), token_type: String(token.token_type ?? 'Bearer'),
    expires_in: Number(token.expires_in ?? 3600), scopes: granted, saved_at: new Date().toISOString()
  };
  if (!bundle.access_token || !bundle.refresh_token) throw new ActionableError('OpenAI returned incomplete credentials.', { action: 'Start again.', code: 'chatgpt_exchange', retryable: true });
  const saved = await importer(userId, bundle);
  return { email: saved.email };
}
