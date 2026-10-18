import crypto from 'node:crypto';
import { Collection } from '../collection.js';
import { ActionableError } from '../diagnostics.js';
import { createNotification } from '../notify.js';
import { services } from '../agent/services.js';
import { getAgentSettings } from '../agent/settings.js';
import { zonedTimeToUtc } from '../agent/time.js';
import { getUser } from '../store.js';
import { createCommitment, commitments, dismissCommitment, resolveCommitment } from '../agent/commitments.js';
import { pactLimits, publicBaseUrl } from './config.js';
import type { Pact, PactAction, PactActor, PactDirection, PactEvent, PactRole, PublicPact } from './types.js';

export const pacts = new Collection<Pact>('pacts');

const MAX_EVENTS = 60;
const MAX_NOTE = 280;
const MAX_HORIZON_MS = 2 * 365 * 86_400_000;
const CAS_ATTEMPTS = 4;
// Built from escapes (not a literal) so the line-separator characters stay visible in source.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u2028\\u2029]', 'g');

/** Called after the owner changes a federated pact, so the peer's copy can follow. Set by the federation module. */
export const pactHooks: { onOwnerAction?: (pact: Pact, event: PactEvent) => Promise<void> } = {};

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();

/** Strips control characters and caps length; the result is only ever rendered as text. */
export function cleanNote(value: unknown, max = MAX_NOTE): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || undefined;
}

export const roleOf = (direction: PactDirection, actor: PactActor): PactRole => {
  const ownerRole: PactRole = direction === 'i_owe' ? 'doer' : 'requester';
  if (actor === 'owner') return ownerRole;
  return ownerRole === 'doer' ? 'requester' : 'doer';
};

/** Which actions each side may take. The doer commits and delivers; the requester can ask for changes or withdraw. */
export const ALLOWED: Record<PactRole, PactAction[]> = {
  doer: ['confirm', 'done', 'reschedule', 'decline'],
  requester: ['confirm', 'done', 'reschedule', 'cancel']
};

export interface NewPact {
  direction: PactDirection;
  otherPerson: string;
  otherEmail?: string;
  action: string;
  dueAt?: string;
  commitmentId?: string;
  channel?: Pact['channel'];
  peerId?: string;
  remotePactId?: string;
}

function freshLink(): { token: (id: string) => string; hash: string; expiresAt: string } {
  const secret = crypto.randomBytes(24).toString('base64url');
  return { token: (id) => `${id}.${secret}`, hash: sha256(secret), expiresAt: new Date(Date.now() + pactLimits().linkTtlDays * 86_400_000).toISOString() };
}

export function pactUrl(token: string): string {
  return `${publicBaseUrl()}/p/${token}`;
}

/** A plain date (no time) means “by 5 pm that day” in the owner’s timezone, so a link’s date never lands a day early. */
function validDue(value: string | undefined, timeZone = 'UTC'): string | undefined {
  if (!value) return undefined;
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const time = plain ? zonedTimeToUtc({ year: Number(plain[1]), month: Number(plain[2]), day: Number(plain[3]), hour: 17, minute: 0 }, timeZone).getTime() : Date.parse(value);
  if (Number.isNaN(time)) throw new ActionableError('That date is not valid.', { action: 'Pick a date and time.', code: 'invalid_date' });
  if (time > Date.now() + MAX_HORIZON_MS) throw new ActionableError('That date is too far away.', { action: 'Pick a date within two years.', code: 'invalid_date' });
  return new Date(time).toISOString();
}

export async function openPactCount(userId: string): Promise<number> {
  return pacts.count(userId, { status: 'open' });
}

export interface CreatedPact {
  pact: Pact;
  /** The only time the link exists in readable form. Shown once, then only its hash is kept. */
  token?: string;
  url?: string;
  created: boolean;
}

export async function createPact(userId: string, input: NewPact, now = new Date()): Promise<CreatedPact> {
  if (!pactLimits().enabled) throw new ActionableError('Pacts are turned off on this installation.', { action: 'Set PACTS_ENABLED=true and redeploy.', code: 'pacts_disabled' });
  if ((await openPactCount(userId)) >= pactLimits().maxOpenPacts) throw new ActionableError('There are too many open pacts.', { action: 'Close some pacts first.', code: 'pact_limit' });
  const channel = input.channel ?? 'link';
  const dueAt = validDue(input.dueAt, (await getAgentSettings(userId)).timezone);
  const id = crypto.randomUUID();
  const person = cleanNote(input.otherPerson, 120);
  const action = cleanNote(input.action, 240);
  if (!person || !action) throw new ActionableError('A pact needs a person and a description.', { action: 'Fill in both fields.', code: 'invalid_request' });
  const link = channel === 'link' ? freshLink() : undefined;
  let commitmentId = input.commitmentId;
  if (commitmentId) {
    const owned = await commitments.get(userId, commitmentId);
    if (!owned) throw new ActionableError('That tracked item no longer exists.', { action: 'Refresh Waiting On.', code: 'not_found' });
  } else {
    commitmentId = (await createCommitment(userId, { direction: input.direction, otherPerson: person, otherEmail: input.otherEmail, action, expectedAt: dueAt }, now)).commitment.id;
  }
  const pact: Pact = {
    id, userId, createdAt: now.toISOString(), updatedAt: now.toISOString(), direction: input.direction, otherPerson: person,
    otherEmail: input.otherEmail?.toLowerCase().slice(0, 200), action, status: 'open', confirmed: false, dueAt, commitmentId, channel,
    linkHash: link?.hash, linkExpiresAt: link?.expiresAt, peerId: input.peerId, remotePactId: input.remotePactId,
    events: [{ at: now.toISOString(), actor: 'owner', action: 'created' }], rev: 1
  };
  // A pact made from the same commitment twice returns the first one rather than a second live link.
  const key = input.remotePactId ? `remote:${input.peerId}:${input.remotePactId}` : `commitment:${commitmentId}`;
  const inserted = await pacts.insert(pact, key);
  if (!inserted.created) return { pact: inserted.item, created: false };
  return { pact: inserted.item, token: link?.token(id), url: link ? pactUrl(link.token(id)) : undefined, created: true };
}

/** Replaces the link secret. The old link stops working immediately. */
export async function rotateLink(userId: string, pactId: string): Promise<{ pact: Pact; token: string; url: string }> {
  const pact = await pacts.get(userId, pactId);
  if (!pact || pact.channel !== 'link') throw new ActionableError('That pact has no shareable link.', { action: 'Refresh Pacts.', code: 'not_found' });
  const link = freshLink();
  const event: PactEvent = { at: nowIso(), actor: 'owner', action: 'link_rotated' };
  const updated = await mutate(userId, pactId, (current) => ({ linkHash: link.hash, linkExpiresAt: link.expiresAt, linkRevokedAt: undefined, events: appendEvent(current, event) }));
  const token = link.token(pactId);
  return { pact: updated, token, url: pactUrl(token) };
}

export async function revokeLink(userId: string, pactId: string): Promise<Pact> {
  const event: PactEvent = { at: nowIso(), actor: 'owner', action: 'link_revoked' };
  return mutate(userId, pactId, (current) => ({ linkRevokedAt: nowIso(), events: appendEvent(current, event) }));
}

const appendEvent = (pact: Pact, event: PactEvent): PactEvent[] => [...pact.events, event].slice(-MAX_EVENTS);

/** Compare-and-set on `rev` with a few retries, so simultaneous clicks cannot lose each other's changes. */
async function mutate(userId: string, pactId: string, build: (pact: Pact) => Partial<Pact> | null): Promise<Pact> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = await pacts.get(userId, pactId);
    if (!current) throw new ActionableError('That pact no longer exists.', { action: 'Refresh Pacts.', code: 'not_found' });
    const patch = build(current);
    if (patch === null) return current;
    const saved = await pacts.updateIf(userId, pactId, { rev: current.rev }, { ...patch, rev: current.rev + 1, updatedAt: nowIso() });
    if (saved) return saved;
  }
  throw new ActionableError('That pact changed at the same moment. Try again.', { action: 'Retry.', code: 'conflict', retryable: true });
}

export interface ActionInput {
  note?: unknown;
  date?: unknown;
}

export interface ApplyResult {
  pact: Pact;
  changed: boolean;
}

/**
 * The single place pact state changes. Used by the public link, federated peers and the owner, so the rules
 * (who may do what, one outcome per pact, honest bookkeeping) cannot drift between the three.
 */
export async function applyAction(userId: string, pactId: string, actor: PactActor, action: PactAction, input: ActionInput = {}): Promise<ApplyResult> {
  const note = cleanNote(input.note);
  const date = action === 'reschedule' ? validDue(typeof input.date === 'string' ? input.date : undefined, (await getAgentSettings(userId)).timezone) : undefined;
  if (action === 'reschedule' && !date) throw new ActionableError('Pick the new date.', { action: 'Choose a date and try again.', code: 'invalid_date' });
  let changed = false;
  let appliedEvent: PactEvent | undefined;
  const pact = await mutate(userId, pactId, (current) => {
    const role = roleOf(current.direction, actor);
    if (!ALLOWED[role].includes(action)) throw new ActionableError('That action is not available for this pact.', { action: 'Choose one of the offered actions.', code: 'action_not_allowed' });
    if (current.status !== 'open') throw new ActionableError(`This pact is already ${current.status}.`, { action: 'Nothing more is needed.', code: 'pact_closed' });
    const event: PactEvent = { at: nowIso(), actor, action, note, date };
    if (action === 'confirm') {
      if (current.confirmed) return null;
      changed = true;
      appliedEvent = event;
      return { confirmed: true, events: appendEvent(current, event) };
    }
    changed = true;
    appliedEvent = event;
    if (action === 'done') return { status: 'done', confirmed: true, events: appendEvent(current, event) };
    if (action === 'decline') return { status: 'declined', events: appendEvent(current, event) };
    if (action === 'cancel') return { status: 'canceled', events: appendEvent(current, event) };
    // reschedule: the doer sets their own date; the requester can only ask.
    return role === 'doer' ? { dueAt: date, requestedDueAt: undefined, events: appendEvent(current, event) } : { requestedDueAt: date, events: appendEvent(current, event) };
  });
  if (changed && appliedEvent) await afterChange(pact, actor, appliedEvent);
  return { pact, changed };
}

async function afterChange(pact: Pact, actor: PactActor, event: PactEvent): Promise<void> {
  const action = event.action as PactAction;
  if (pact.commitmentId) {
    if (action === 'done') await resolveCommitment(pact.userId, pact.commitmentId);
    else if (action === 'decline' || action === 'cancel') await dismissCommitment(pact.userId, pact.commitmentId);
    else if (action === 'reschedule' && pact.dueAt && roleOf(pact.direction, actor) === 'doer') await commitments.update(pact.userId, pact.commitmentId, { expectedAt: pact.dueAt, followUpAt: pact.dueAt, updatedAt: nowIso() });
  }
  if (actor !== 'owner') {
    const message = { title: notificationTitle(pact, action), body: notificationBody(pact, event), kind: (action === 'decline' || action === 'cancel' ? 'alert' : 'info') as 'alert' | 'info' };
    await createNotification(pact.userId, { ...message, link: '/#/pacts' });
    // A reply from the other person is worth a ping where the owner already reads Orbit's messages.
    const settings = await getAgentSettings(pact.userId);
    if (settings.channels.telegram.enabled && settings.channels.telegram.chatId) await services().notifier.deliver(pact.userId, message, ['telegram']).catch(() => undefined);
  } else if (pact.channel === 'federated') {
    await pactHooks.onOwnerAction?.(pact, event);
  }
}

function notificationTitle(pact: Pact, action: PactAction): string {
  const who = pact.otherPerson;
  switch (action) {
    case 'confirm': return `${who} confirmed`;
    case 'done': return `${who} marked it done`;
    case 'reschedule': return roleOf(pact.direction, 'counterparty') === 'doer' ? `${who} moved the date` : `${who} asked for a new date`;
    case 'decline': return `${who} can’t do it`;
    default: return `${who} no longer needs it`;
  }
}

function notificationBody(pact: Pact, event: PactEvent): string {
  const when = event.date ? ` New date: ${event.date.slice(0, 10)}.` : '';
  return `${pact.action}.${when}${event.note ? ` They wrote: “${event.note}”` : ''}`.slice(0, 500);
}

export async function listPacts(userId: string, status?: Pact['status'][]): Promise<Pact[]> {
  return pacts.list(userId, status ? { where: { status } } : {});
}

export const getPact = (userId: string, id: string) => pacts.get(userId, id);

export async function deletePact(userId: string, id: string): Promise<boolean> {
  return pacts.delete(userId, id);
}

export function splitToken(token: string): { id: string; secret: string } | null {
  const match = /^([A-Za-z0-9-]{8,64})\.([A-Za-z0-9_-]{20,64})$/.exec(token);
  return match ? { id: match[1], secret: match[2] } : null;
}

/** Looks up a pact by its link token. Wrong, expired and revoked links are indistinguishable to the caller. */
export async function pactForToken(token: string, now = new Date()): Promise<Pact | null> {
  const parts = splitToken(token);
  if (!parts) return null;
  const pact = await pacts.getAnyOwner(parts.id);
  if (!pact || pact.channel !== 'link' || !pact.linkHash || pact.linkRevokedAt) return null;
  const expected = Buffer.from(pact.linkHash, 'hex');
  const actual = Buffer.from(sha256(parts.secret), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  if (pact.linkExpiresAt && pact.linkExpiresAt <= now.toISOString()) return null;
  return pact;
}

export async function publicView(pact: Pact): Promise<PublicPact> {
  const [owner, settings] = await Promise.all([getUser(pact.userId), getAgentSettings(pact.userId)]);
  return {
    timeZone: settings.timezone,
    ownerName: cleanNote(owner?.name, 80) ?? 'Someone', otherPerson: pact.otherPerson, action: pact.action, dueAt: pact.dueAt, status: pact.status,
    confirmed: pact.confirmed, role: roleOf(pact.direction, 'counterparty'), requestedDueAt: pact.requestedDueAt, expiresAt: pact.linkExpiresAt
  };
}

/** A ready-to-paste message the owner can send themselves. Orbit never sends it. */
export function shareMessage(pact: Pact, url: string, ownerName: string): string {
  const due = pact.dueAt ? ` by ${pact.dueAt.slice(0, 10)}` : '';
  const line = pact.direction === 'they_owe' ? `you mentioned you’d ${pact.action}${due}.` : `I’m going to ${pact.action}${due}.`;
  return `Hi ${pact.otherPerson.split(' ')[0]}, ${line} I’m tracking it here so neither of us has to chase: ${url}\n— ${ownerName}`;
}

/** Pacts that are open and past their date, for nudges and the digest. */
export async function overduePacts(userId: string, now = new Date()): Promise<Pact[]> {
  return (await listPacts(userId, ['open'])).filter((pact) => pact.dueAt && pact.dueAt <= now.toISOString());
}
