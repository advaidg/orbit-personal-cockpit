import crypto from 'node:crypto';
import { z } from 'zod';
import { privateKeyOf, publicKeyObject, type Identity } from './identity.js';

export const CLOCK_SKEW_MS = 5 * 60_000;

const envelopeSchema = z.object({
  v: z.literal(1),
  id: z.string().uuid(),
  type: z.enum(['hello', 'pact.propose', 'pact.update']),
  from: z.string().url().max(300),
  to: z.string().url().max(300),
  ts: z.number().int(),
  body: z.record(z.string(), z.unknown()),
  sig: z.string().min(40).max(200)
});

export type Envelope = z.infer<typeof envelopeSchema>;
export type Unsigned = Omit<Envelope, 'sig'>;

/** Deterministic JSON: keys sorted at every level, so both sides sign and verify identical bytes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sign(identity: Identity, message: Unsigned): Envelope {
  const sig = crypto.sign(null, Buffer.from(canonical(message)), privateKeyOf(identity)).toString('base64url');
  return { ...message, sig };
}

export function parseEnvelope(raw: unknown): Envelope | null {
  const parsed = envelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function verify(envelope: Envelope, publicKey: string): boolean {
  const { sig, ...message } = envelope;
  try {
    return crypto.verify(null, Buffer.from(canonical(message)), publicKeyObject(publicKey), Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

export const fresh = (envelope: Envelope, now = Date.now()): boolean => Math.abs(now - envelope.ts) <= CLOCK_SKEW_MS;
