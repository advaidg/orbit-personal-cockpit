import { z } from 'zod';
import { ActionableError, logSafe } from '../diagnostics.js';
import { createNotification } from '../notify.js';
import { pactLimits, publicBaseUrl } from '../pacts/config.js';
import { applyAction, cleanNote, createPact, pacts } from '../pacts/service.js';
import type { Pact } from '../pacts/types.js';
import { fetchPeerDocument, federationOwner } from './discovery.js';
import { federation, findPeerByUrl, listPeers, markSeen, savePeer, type Peer } from './identity.js';
import { CLOCK_SKEW_MS, fresh, parseEnvelope, verify, type Envelope } from './messages.js';

export interface InboxReply {
  status: number;
  body: Record<string, unknown>;
}

const MAX_PENDING_PEERS = 20;
const MAX_OPEN_PER_PEER = 50;

const reply = (status: number, body: Record<string, unknown> = {}): InboxReply => ({ status, body });
// One generic answer for every authentication failure, so the endpoint reveals nothing about who is trusted.
const REJECTED = reply(401, { error: 'rejected' });

const proposeBody = z.object({
  pactId: z.string().min(8).max(64),
  action: z.string().min(1).max(500),
  dueAt: z.string().max(40).optional(),
  fromName: z.string().max(120).optional(),
  senderOwes: z.boolean()
});

const updateBody = z.object({
  pactId: z.string().min(8).max(64),
  action: z.enum(['confirm', 'done', 'reschedule', 'decline', 'cancel']),
  note: z.string().max(1000).optional(),
  date: z.string().max(40).optional()
});

async function wasSeen(userId: string, id: string): Promise<boolean> {
  return !!(await federation.findByUniqueKey(userId, `seen:${id}`));
}

async function findMirrorOrOrigin(userId: string, peer: Peer, remoteId: string): Promise<Pact | null> {
  const mirror = await pacts.findByUniqueKey(userId, `remote:${peer.id}:${remoteId}`);
  if (mirror) return mirror;
  const origin = await pacts.get(userId, remoteId);
  return origin && origin.peerId === peer.id ? origin : null;
}

async function onHello(userId: string, envelope: Envelope, origin: string): Promise<InboxReply> {
  const existing = await findPeerByUrl(userId, origin);
  if (existing) {
    if (existing.status === 'blocked') return REJECTED;
    return verify(envelope, existing.publicKey) ? reply(202) : REJECTED;
  }
  const pending = (await listPeers(userId)).filter((peer) => peer.status === 'pending_in').length;
  if (pending >= MAX_PENDING_PEERS) return reply(429, { error: 'too_many_requests' });
  let found;
  try {
    // The key comes from the sender's own origin, so a valid signature proves they control that address.
    found = await fetchPeerDocument(origin);
  } catch {
    return REJECTED;
  }
  if (!verify(envelope, found.publicKey)) return REJECTED;
  const { peer, created } = await savePeer(userId, { url: origin, name: found.name, publicKey: found.publicKey, status: 'pending_in' });
  if (created) await createNotification(userId, { title: `${peer.name} wants to share pacts`, body: `Compare the fingerprint ${peer.fingerprint} with theirs before you trust ${origin}.`, kind: 'info', link: '/#/pacts' });
  return reply(202);
}

async function onPropose(userId: string, peer: Peer, envelope: Envelope): Promise<InboxReply> {
  const parsed = proposeBody.safeParse(envelope.body);
  if (!parsed.success) return reply(400, { error: 'invalid_message' });
  const body = parsed.data;
  const open = (await pacts.list(userId, { where: { peerId: peer.id, status: 'open' } })).length;
  if (open >= MAX_OPEN_PER_PEER) return reply(429, { error: 'too_many_open_pacts' });
  const due = body.dueAt && !Number.isNaN(Date.parse(body.dueAt)) ? new Date(body.dueAt).toISOString() : undefined;
  try {
    const { pact, created } = await createPact(userId, {
      direction: body.senderOwes ? 'they_owe' : 'i_owe', otherPerson: cleanNote(body.fromName, 120) ?? peer.name, action: cleanNote(body.action, 240) ?? 'a promise',
      dueAt: due && Date.parse(due) <= Date.now() + 2 * 365 * 86_400_000 ? due : undefined, channel: 'federated', peerId: peer.id, remotePactId: body.pactId
    });
    if (created) await createNotification(userId, { title: `${peer.name} sent you a pact`, body: `${pact.action}`.slice(0, 300), kind: 'info', link: '/#/pacts' });
    return reply(created ? 201 : 200, { ok: true });
  } catch (error) {
    if (error instanceof ActionableError) return reply(409, { error: error.options.code ?? 'rejected' });
    throw error;
  }
}

async function onUpdate(userId: string, peer: Peer, envelope: Envelope): Promise<InboxReply> {
  const parsed = updateBody.safeParse(envelope.body);
  if (!parsed.success) return reply(400, { error: 'invalid_message' });
  const pact = await findMirrorOrOrigin(userId, peer, parsed.data.pactId);
  if (!pact) return reply(404, { error: 'unknown_pact' });
  try {
    await applyAction(userId, pact.id, 'peer', parsed.data.action, { note: parsed.data.note, date: parsed.data.date });
    return reply(200, { ok: true });
  } catch (error) {
    if (error instanceof ActionableError) return reply(409, { error: error.options.code ?? 'rejected' });
    throw error;
  }
}

/**
 * Handles one signed message from another installation. Order matters: shape, addressee, freshness, sender,
 * signature, replay, and only then business logic. Every failure before the replay check looks identical.
 */
export async function handleInbound(raw: unknown, now = Date.now()): Promise<InboxReply> {
  if (!pactLimits().federationEnabled) return reply(404, { error: 'not_found' });
  try {
    const owner = await federationOwner();
    if (!owner) return reply(404, { error: 'not_found' });
    const envelope = parseEnvelope(raw);
    if (!envelope) return reply(400, { error: 'invalid_message' });
    let from: string;
    try {
      from = new URL(envelope.from).origin;
    } catch {
      return REJECTED;
    }
    if (new URL(envelope.to).origin !== publicBaseUrl() || from === publicBaseUrl() || !fresh(envelope, now)) return reply(400, { error: 'invalid_message', skewMs: CLOCK_SKEW_MS });
    if (envelope.type === 'hello') return await onHello(owner.id, envelope, from);
    const peer = await findPeerByUrl(owner.id, from);
    if (!peer || peer.status !== 'trusted' || !verify(envelope, peer.publicKey)) return REJECTED;
    if (await wasSeen(owner.id, envelope.id)) return reply(200, { ok: true, duplicate: true });
    const result = envelope.type === 'pact.propose' ? await onPropose(owner.id, peer, envelope) : await onUpdate(owner.id, peer, envelope);
    if (result.status < 500) await markSeen(owner.id, envelope.id);
    await federation.update(owner.id, peer.id, { lastSeenAt: new Date(now).toISOString() } as never);
    return result;
  } catch (error) {
    logSafe('federation inbox', error);
    return reply(500, { error: 'server_error' });
  }
}
