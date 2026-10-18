import express from 'express';
import { z } from 'zod';
import { ActionableError } from '../diagnostics.js';
import { getUser } from '../store.js';
import { pactLimits } from '../pacts/config.js';
import { applyAction, createPact, deletePact, getPact, listPacts, revokeLink, rotateLink, shareMessage, pactUrl } from '../pacts/service.js';
import type { Pact } from '../pacts/types.js';
import { getPeer } from '../federation/identity.js';
import { listJobs } from '../jobs.js';
import { handle, ownerId } from './http.js';

export const pactsRouter = express.Router();

/** The stored hash never leaves the server; the owner sees only whether a link is usable. */
export function ownerPact(pact: Pact) {
  const { linkHash, ...rest } = pact;
  const now = new Date().toISOString();
  return { ...rest, link: pact.channel === 'link' ? { active: !!linkHash && !pact.linkRevokedAt && (!pact.linkExpiresAt || pact.linkExpiresAt > now), expiresAt: pact.linkExpiresAt, revoked: !!pact.linkRevokedAt } : undefined };
}

const dateText = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Use a valid date');

const createBody = z.object({
  direction: z.enum(['i_owe', 'they_owe']),
  otherPerson: z.string().trim().min(1).max(120),
  otherEmail: z.string().trim().email().max(200).optional().or(z.literal('')),
  action: z.string().trim().min(1).max(240),
  dueAt: dateText.optional(),
  commitmentId: z.string().max(100).optional(),
  peerId: z.string().max(100).optional()
});

async function shared(pact: Pact, token: string, url: string) {
  const owner = await getUser(pact.userId);
  return { token, url, message: shareMessage(pact, url, owner?.name ?? '') };
}

pactsRouter.get('/', handle(async (req, res) => {
  const status = typeof req.query.status === 'string' ? (req.query.status.split(',').filter((value) => ['open', 'done', 'declined', 'canceled'].includes(value)) as Pact['status'][]) : undefined;
  const items = await listPacts(ownerId(res), status?.length ? status : undefined);
  // For pacts shared Orbit-to-Orbit, say whether the latest message reached the other side.
  const sends = items.some((pact) => pact.channel === 'federated') ? await listJobs(ownerId(res), { kind: 'federation.send', limit: 200 }) : [];
  const deliveryOf = (pact: Pact): 'queued' | 'delivered' | 'failed' | undefined => {
    if (pact.channel !== 'federated') return undefined;
    const latest = sends.find((job) => (job.payload.body as { pactId?: string } | undefined)?.pactId === (pact.remotePactId ?? pact.id)); // newest first
    if (!latest) return undefined;
    return latest.status === 'succeeded' ? (latest.result?.delivered === true ? 'delivered' : 'failed') : latest.status === 'failed' || latest.status === 'canceled' ? 'failed' : 'queued';
  };
  res.json({ pacts: items.map((pact) => ({ ...ownerPact(pact), delivery: deliveryOf(pact) })), enabled: pactLimits().enabled, baseUrl: pactUrl('').replace(/\/p\/$/, '') });
}));

pactsRouter.post('/', handle(async (req, res) => {
  const input = createBody.parse(req.body);
  const channel = input.peerId ? 'federated' : 'link';
  if (input.peerId) {
    if (!pactLimits().federationEnabled) throw new ActionableError('Orbit-to-Orbit sharing is turned off.', { action: 'Set FEDERATION_ENABLED=true and redeploy.', code: 'federation_disabled' });
    const peer = await getPeer(ownerId(res), input.peerId);
    if (peer?.status !== 'trusted') throw new ActionableError('You can only send pacts to an Orbit you have approved.', { action: 'Trust them in Pacts → Connections first.', code: 'peer_not_trusted' });
  }
  const { pact, token, url, created } = await createPact(ownerId(res), { ...input, otherEmail: input.otherEmail || undefined, channel, dueAt: input.dueAt });
  if (channel === 'federated') {
    const { sendProposal } = await import('../federation/outbox.js');
    await sendProposal(pact);
    return res.status(created ? 201 : 200).json({ pact: ownerPact(pact), created });
  }
  res.status(created ? 201 : 200).json({ pact: ownerPact(pact), created, ...(token && url ? await shared(pact, token, url) : {}) });
}));

pactsRouter.post('/:id/link', handle(async (req, res) => {
  const { pact, token, url } = await rotateLink(ownerId(res), String(req.params.id));
  res.json({ pact: ownerPact(pact), ...(await shared(pact, token, url)) });
}));

pactsRouter.delete('/:id/link', handle(async (req, res) => {
  res.json({ pact: ownerPact(await revokeLink(ownerId(res), String(req.params.id))) });
}));

const actionBody = z.object({ action: z.enum(['confirm', 'done', 'reschedule', 'decline', 'cancel']), note: z.string().max(1000).optional(), date: dateText.optional() });

pactsRouter.post('/:id/action', handle(async (req, res) => {
  const { action, note, date } = actionBody.parse(req.body);
  const result = await applyAction(ownerId(res), String(req.params.id), 'owner', action, { note, date });
  res.json({ pact: ownerPact(result.pact), changed: result.changed });
}));

pactsRouter.delete('/:id', handle(async (req, res) => {
  const pact = await getPact(ownerId(res), String(req.params.id));
  if (!pact) throw new ActionableError('That pact no longer exists.', { action: 'Refresh Pacts.', code: 'not_found' });
  await deletePact(ownerId(res), pact.id);
  res.status(204).end();
}));
