import crypto from 'node:crypto';
import { ActionableError } from '../diagnostics.js';
import { Collection, type Owned } from '../collection.js';
import { saveAgentSettings } from '../agent/settings.js';

interface LinkCode extends Owned {
  kind: 'code';
  codeHash: string;
  expiresAt: string;
  used: boolean;
  usedAt?: string;
}

interface Binding extends Owned {
  kind: 'binding';
  chatId: string;
}

type LinkDoc = LinkCode | Binding;

const links = new Collection<LinkDoc>('channel_links');
const CODE_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_CODES = 5;
// No 0/O/1/I so a code read aloud or retyped is hard to get wrong.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const hash = (code: string) => crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

export function newCode(): string {
  return Array.from(crypto.randomBytes(8), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export async function createLinkCode(userId: string, now = new Date()): Promise<{ code: string; expiresAt: string }> {
  const active = ((await links.list(userId, { where: { kind: 'code', used: false } })) as LinkCode[]).filter((item) => item.expiresAt > now.toISOString());
  if (active.length >= MAX_ACTIVE_CODES) throw new ActionableError('Too many unused link codes.', { action: 'Use the latest code or wait ten minutes.', code: 'too_many_codes' });
  const code = newCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
  await links.insert({ id: crypto.randomUUID(), userId, kind: 'code', createdAt: now.toISOString(), codeHash: hash(code), expiresAt, used: false }, `code:${hash(code)}`);
  return { code, expiresAt };
}

const failures = new Map<string, { count: number; first: number }>();
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 5;

function tooManyFailures(chatId: string, now: number): boolean {
  const entry = failures.get(chatId);
  if (!entry || now - entry.first > FAILURE_WINDOW_MS) return false;
  return entry.count >= MAX_FAILURES;
}

function recordFailure(chatId: string, now: number): void {
  const entry = failures.get(chatId);
  if (!entry || now - entry.first > FAILURE_WINDOW_MS) failures.set(chatId, { count: 1, first: now });
  else entry.count += 1;
}

export function resetLinkFailures(): void {
  failures.clear();
}

/**
 * Binds a Telegram private chat to the owner who generated the code. Codes are single-use, expire after ten
 * minutes and are stored only as hashes. Repeated wrong guesses from one chat are ignored for ten minutes.
 */
export async function consumeLinkCode(code: string, chatId: string, now = new Date()): Promise<string | null> {
  if (tooManyFailures(chatId, now.getTime())) return null;
  const candidates = (await links.listAllOwners({ where: { kind: 'code', codeHash: hash(code) } })) as LinkCode[];
  const match = candidates[0];
  if (!match || match.used || match.expiresAt <= now.toISOString()) {
    recordFailure(chatId, now.getTime());
    return null;
  }
  const claimed = await links.updateIf(match.userId, match.id, { used: false }, { used: true, usedAt: now.toISOString() });
  if (!claimed) return null;
  await links.insert({ id: crypto.randomUUID(), userId: match.userId, kind: 'binding', createdAt: now.toISOString(), chatId }, `chat:${chatId}`);
  // A chat can belong to one owner only; if another owner held it (not possible single-tenant) the insert above is a no-op.
  await saveAgentSettings(match.userId, { channels: { telegram: { enabled: true, chatId } } });
  return match.userId;
}

/** Which owner, if any, has linked this chat. The only authority for accepting commands from Telegram. */
export async function ownerForChat(chatId: string): Promise<string | null> {
  const found = (await links.listAllOwners({ where: { kind: 'binding', chatId } })) as Binding[];
  return found[0]?.userId ?? null;
}

export async function boundChats(): Promise<Array<{ userId: string; chatId: string }>> {
  return ((await links.listAllOwners({ where: { kind: 'binding' } })) as Binding[]).map((item) => ({ userId: item.userId, chatId: item.chatId }));
}

export async function isLinked(userId: string): Promise<boolean> {
  return ((await links.list(userId, { where: { kind: 'binding' } })) as Binding[]).length > 0;
}

export async function unlink(userId: string): Promise<void> {
  await links.deleteWhere(userId, { kind: 'binding' });
  await saveAgentSettings(userId, { channels: { telegram: { enabled: false, chatId: undefined } } });
}
