import { ActionableError } from '../diagnostics.js';
import { saveSetting } from '../installationConfig.js';
import { publicBaseUrl } from '../pacts/config.js';
import { PendingFlows } from './pending.js';
import { newPkce, randomToken } from './pkce.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

interface Attempt { verifier: string }
const attempts = new PendingFlows<Attempt>();

export function resetOpenRouterFlows(): void {
  attempts.clear();
}

export type KeyExchange = (code: string, verifier: string) => Promise<string>;

const realKeyExchange: KeyExchange = async (code, verifier) => {
  const response = await fetch(`${OPENROUTER_BASE}/auth/keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }), signal: AbortSignal.timeout(15_000)
  });
  const body = (await response.json().catch(() => ({}))) as { key?: unknown };
  if (!response.ok || typeof body.key !== 'string' || !body.key) throw new ActionableError('OpenRouter would not hand over a key.', { action: 'Start again — the approval link works once.', code: 'openrouter_exchange', retryable: true });
  return body.key;
};

let exchangeImpl: KeyExchange = realKeyExchange;

/** Replaces the key exchange (tests). Returns a function that restores the real one. */
export function setOpenRouterExchange(next: KeyExchange): () => void {
  const previous = exchangeImpl;
  exchangeImpl = next;
  return () => { exchangeImpl = previous; };
}

/**
 * Step 1: send the owner to OpenRouter to approve. OpenRouter returns them to this installation with a one-time
 * code, which the server (not the browser) trades for an API key, so the key is never in a URL or the page.
 */
export function beginOpenRouterAuth(userId: string): { url: string } {
  const pkce = newPkce();
  const state = randomToken();
  attempts.put(`${userId}:${state}`, { verifier: pkce.verifier });
  const callback = `${publicBaseUrl()}/api/setup/openrouter/callback?s=${state}`;
  const url = new URL('https://openrouter.ai/auth');
  url.search = new URLSearchParams({ callback_url: callback, code_challenge: pkce.challenge, code_challenge_method: 'S256' }).toString();
  return { url: url.toString() };
}

/** Step 2: OpenRouter redirected back. Exchange the code and store the key encrypted. */
export async function finishOpenRouterAuth(userId: string, query: { code?: unknown; s?: unknown }): Promise<void> {
  const state = typeof query.s === 'string' ? query.s : '';
  const code = typeof query.code === 'string' ? query.code : '';
  const attempt = state ? attempts.take(`${userId}:${state}`) : undefined;
  if (!attempt) throw new ActionableError('That OpenRouter approval expired or was not started here.', { action: 'Press “Connect OpenRouter” again.', code: 'openrouter_expired' });
  if (!code || code.length > 300) throw new ActionableError('OpenRouter did not send an approval code.', { action: 'Press “Connect OpenRouter” again.', code: 'openrouter_exchange' });
  const key = await exchangeImpl(code, attempt.verifier);
  await saveSetting(userId, 'AI_BASE_URL', OPENROUTER_BASE);
  await saveSetting(userId, 'AI_COMPATIBLE_API_KEY', key);
}
