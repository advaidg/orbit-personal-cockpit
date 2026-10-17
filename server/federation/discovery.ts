import { z } from 'zod';
import { ActionableError } from '../diagnostics.js';
import { assertAllowedUrl, safeFetchText } from '../net.js';
import { publicBaseUrl } from '../pacts/config.js';
import { getUserByEmail } from '../store.js';
import { fingerprintOf } from './identity.js';

const documentSchema = z.object({
  v: z.literal(1),
  url: z.string().url().max(300),
  name: z.string().max(80).default(''),
  publicKey: z.string().min(40).max(200),
  fingerprint: z.string().max(60)
});

export interface PeerDocument {
  url: string;
  name: string;
  publicKey: string;
  fingerprint: string;
}

/** Normalises user input to an origin. Anything with a path, credentials or a non-http(s) scheme is refused. */
export function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new ActionableError('That is not a valid web address.', { action: 'Enter the other person’s Orbit address, for example orbit.example.com.', code: 'bad_url' });
  }
  if (url.username || url.password) throw new ActionableError('Addresses with credentials are not allowed.', { action: 'Use the plain address.', code: 'bad_url' });
  return url.origin;
}

/**
 * Fetches another installation's public key through the SSRF-safe client (https only, public addresses only,
 * no redirects) and checks that it really claims to live at the address we asked for.
 */
export async function fetchPeerDocument(origin: string): Promise<PeerDocument> {
  if (origin === publicBaseUrl()) throw new ActionableError('That is this installation.', { action: 'Enter another person’s address.', code: 'self_peer' });
  const host = new URL(origin).hostname;
  const url = assertAllowedUrl(`${origin}/.well-known/orbit-pacts`, [host]);
  let result;
  try {
    result = await safeFetchText(url, { maxBytes: 8 * 1024, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error instanceof ActionableError) throw error;
    throw new ActionableError(`Could not reach ${host}.`, { action: 'Check the address and that the other installation has FEDERATION_ENABLED=true.', code: 'peer_unreachable', retryable: true });
  }
  if (!result.ok) throw new ActionableError(`${host} did not answer as an Orbit installation.`, { action: 'The other person needs to set FEDERATION_ENABLED=true and OWNER_EMAIL.', code: 'peer_not_orbit' });
  let parsed;
  try {
    parsed = documentSchema.parse(JSON.parse(result.text));
  } catch {
    throw new ActionableError(`${host} did not return a valid Orbit identity.`, { action: 'Check the address.', code: 'peer_not_orbit' });
  }
  if (new URL(parsed.url).origin !== origin) throw new ActionableError('That installation claims to live at a different address.', { action: 'Use the address it announces.', code: 'peer_mismatch' });
  if (fingerprintOf(parsed.publicKey).replace(/ /g, '') !== parsed.fingerprint.replace(/ /g, '')) throw new ActionableError('That identity’s fingerprint does not match its key.', { action: 'Do not trust it.', code: 'peer_mismatch' });
  return { url: origin, name: parsed.name, publicKey: parsed.publicKey, fingerprint: parsed.fingerprint };
}

/** The single owner of this installation. Federation is refused unless OWNER_EMAIL identifies them. */
export async function federationOwner() {
  const email = process.env.OWNER_EMAIL?.trim();
  return email ? getUserByEmail(email) : null;
}
