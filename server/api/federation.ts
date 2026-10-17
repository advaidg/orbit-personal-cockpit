import express from 'express';
import { z } from 'zod';
import { ActionableError } from '../diagnostics.js';
import { fetchPeerDocument, normalizeOrigin } from '../federation/discovery.js';
import { getIdentity, fingerprintOf, getPeer, listPeers, removePeer, savePeer, setPeerStatus } from '../federation/identity.js';
import { enqueueMessage } from '../federation/outbox.js';
import { pactLimits, publicBaseUrl } from '../pacts/config.js';
import { getUser } from '../store.js';
import { handle, ownerId } from './http.js';

export const federationRouter = express.Router();

const compact = (value: string) => value.replace(/\s+/g, '').toLowerCase();

federationRouter.get('/', handle(async (_req, res) => {
  const userId = ownerId(res);
  const enabled = pactLimits().federationEnabled && !!process.env.OWNER_EMAIL;
  if (!enabled) return res.json({ enabled: false, reason: pactLimits().federationEnabled ? 'Set OWNER_EMAIL so peers can find you.' : 'Set FEDERATION_ENABLED=true and redeploy to let Orbit installations share pacts.' });
  const identity = await getIdentity(userId);
  const owner = await getUser(userId);
  res.json({ enabled: true, url: publicBaseUrl(), name: owner?.name ?? '', fingerprint: fingerprintOf(identity.publicKey), peers: (await listPeers(userId)).map(({ publicKey, ...peer }) => peer) });
}));

function requireEnabled(): void {
  if (!pactLimits().federationEnabled) throw new ActionableError('Federation is turned off on this installation.', { action: 'Set FEDERATION_ENABLED=true and redeploy.', code: 'federation_disabled' });
}

federationRouter.post('/peers', handle(async (req, res) => {
  requireEnabled();
  const userId = ownerId(res);
  const origin = normalizeOrigin(z.object({ url: z.string().min(3).max(300) }).parse(req.body).url);
  const found = await fetchPeerDocument(origin);
  const { peer, created } = await savePeer(userId, { url: origin, name: found.name, publicKey: found.publicKey, status: 'pending_out' });
  if (!created && peer.publicKey !== found.publicKey) throw new ActionableError('That installation’s key changed since you added it.', { action: 'Remove it and compare fingerprints again before re-adding.', code: 'peer_key_changed' });
  // Introduce ourselves; the other side sees a pending request it must approve.
  if (created) await enqueueMessage(userId, peer.id, 'hello', {}, `hello:${peer.id}`);
  const { publicKey, ...safe } = peer;
  res.status(created ? 201 : 200).json({ peer: safe });
}));

federationRouter.post('/peers/:id/trust', handle(async (req, res) => {
  requireEnabled();
  const userId = ownerId(res);
  const peer = await getPeer(userId, String(req.params.id));
  if (!peer) throw new ActionableError('That peer no longer exists.', { action: 'Refresh Pacts.', code: 'not_found' });
  const typed = z.object({ fingerprint: z.string().max(80) }).parse(req.body).fingerprint;
  if (compact(typed) !== compact(peer.fingerprint)) throw new ActionableError('That fingerprint does not match.', { action: 'Ask the other person to read their fingerprint from Pacts → Connections, then enter it exactly.', code: 'fingerprint_mismatch' });
  const trusted = await setPeerStatus(userId, peer.id, 'trusted');
  await enqueueMessage(userId, peer.id, 'hello', {}, `hello-trusted:${peer.id}`);
  const { publicKey, ...safe } = trusted!;
  res.json({ peer: safe });
}));

federationRouter.post('/peers/:id/block', handle(async (req, res) => {
  const peer = await setPeerStatus(ownerId(res), String(req.params.id), 'blocked');
  if (!peer) throw new ActionableError('That peer no longer exists.', { action: 'Refresh Pacts.', code: 'not_found' });
  const { publicKey, ...safe } = peer;
  res.json({ peer: safe });
}));

federationRouter.delete('/peers/:id', handle(async (req, res) => {
  if (!(await removePeer(ownerId(res), String(req.params.id)))) throw new ActionableError('That peer no longer exists.', { action: 'Refresh Pacts.', code: 'not_found' });
  res.status(204).end();
}));
