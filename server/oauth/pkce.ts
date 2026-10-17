import crypto from 'node:crypto';

export const randomToken = (bytes = 24): string => crypto.randomBytes(bytes).toString('base64url');

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}
