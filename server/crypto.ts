import crypto from 'node:crypto';

const encryptionSecret = process.env.APP_ENCRYPTION_KEY || 'orbit-local-encryption-key-change-me';
const sessionSecret = process.env.SESSION_SECRET || 'orbit-local-session-key-change-me';
const encryptionKey = crypto.createHash('sha256').update(encryptionSecret).digest();
const sessionKey = crypto.createHash('sha256').update(sessionSecret).digest();

export function encrypt(value: unknown) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, data].map((part) => part.toString('base64url')).join('.');
}

export function decrypt<T>(value: string): T {
  const [iv, tag, data] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as T;
}

export function signSession(userId: string, ttlSeconds = 30 * 86400) {
  const payload = Buffer.from(JSON.stringify({ userId, expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySession(value?: string) {
  if (!value) return null;
  const split = value.lastIndexOf('.');
  if (split < 1) return null;
  const payload = value.slice(0, split);
  const signature = value.slice(split + 1);
  const expected = crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { userId?: unknown; expiresAt?: unknown };
    if (typeof parsed.userId !== 'string' || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now() / 1000) return null;
    return parsed.userId;
  } catch {
    return null;
  }
}
