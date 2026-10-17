import crypto from 'node:crypto';
import { ActionableError, logSafe } from '../diagnostics.js';
import { enqueue, registerJobHandler } from '../jobs.js';
import { assertAllowedUrl, safeFetchText } from '../net.js';
import { pactLimits, publicBaseUrl } from '../pacts/config.js';
import { pactHooks } from '../pacts/service.js';
import type { Pact, PactEvent } from '../pacts/types.js';
import { getUser, logActivity } from '../store.js';
import { getIdentity, getPeer } from './identity.js';
import { sign, type Envelope } from './messages.js';

type MessageType = Envelope['type'];

export async function enqueueMessage(userId: string, peerId: string, type: MessageType, body: Record<string, unknown>, dedupe: string) {
  if (!pactLimits().federationEnabled) return null;
  return enqueue({ kind: 'federation.send', userId, payload: { peerId, type, body, messageId: crypto.randomUUID() }, idempotencyKey: `fed:${userId}:${dedupe}`, maxAttempts: 6 });
}

/** Sends a new pact to the trusted peer holding the other side. */
export async function sendProposal(pact: Pact): Promise<void> {
  if (!pact.peerId) return;
  const owner = await getUser(pact.userId);
  await enqueueMessage(pact.userId, pact.peerId, 'pact.propose', { pactId: pact.id, action: pact.action, dueAt: pact.dueAt, fromName: owner?.name ?? '', senderOwes: pact.direction === 'i_owe' }, `propose:${pact.id}`);
}

async function sendUpdate(pact: Pact, event: PactEvent): Promise<void> {
  if (!pact.peerId) return;
  await enqueueMessage(pact.userId, pact.peerId, 'pact.update', { pactId: pact.remotePactId ?? pact.id, action: event.action, note: event.note, date: event.date }, `update:${pact.id}:${pact.rev}`);
}

/** Signs and delivers one queued message. 5xx and network failures retry; a clear rejection does not. */
async function deliver(userId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const peerId = String(payload.peerId ?? '');
  const type = payload.type as MessageType;
  const peer = await getPeer(userId, peerId);
  if (!peer || peer.status === 'blocked') return { skipped: 'peer_unavailable' };
  if (type !== 'hello' && peer.status !== 'trusted') return { skipped: 'peer_not_trusted' };
  const identity = await getIdentity(userId);
  const envelope = sign(identity, { v: 1, id: String(payload.messageId), type, from: publicBaseUrl(), to: peer.url, ts: Date.now(), body: (payload.body ?? {}) as Record<string, unknown> });
  const url = assertAllowedUrl(`${peer.url}/federation/inbox`, [new URL(peer.url).hostname]);
  const result = await safeFetchText(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), maxBytes: 4 * 1024 });
  if (result.ok) return { delivered: true, status: result.status };
  if (result.status >= 500 || result.status === 429) throw new Error(`Peer answered ${result.status}`);
  await logActivity(userId, { type: 'agent', status: 'info', title: 'A pact update was not accepted', detail: `${peer.name} declined a ${type} message (${result.status}). It will not be retried.`, action: 'Check that you both trust each other in Pacts → Connections.' }).catch((error) => logSafe('activity', error));
  return { rejected: true, status: result.status };
}

export function registerFederationJobs(): void {
  pactHooks.onOwnerAction = sendUpdate;
  registerJobHandler('federation.send', async ({ job }) => {
    if (!job.userId) throw new ActionableError('Federation job has no owner.', { action: 'None.' });
    return deliver(job.userId, job.payload);
  });
}
