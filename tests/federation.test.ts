import crypto from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { drain } from './agentHelpers.js';
import { startApp, type TestServer } from './httpApp.js';

// The network is the only thing replaced: peer discovery and outbound delivery. Signing, verification, trust and
// replay handling are the real code.
const remote = { pair: crypto.generateKeyPairSync('ed25519'), url: 'https://remote.example.test', name: 'Riley (remote)' };
const publicKeyOf = (pair = remote.pair) => pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

const { delivered, discoveryDoc } = vi.hoisted(() => ({ delivered: [] as Array<{ url: string; body: string }>, discoveryDoc: { current: null as null | { url: string; name: string; publicKey: string; fingerprint: string } } }));

vi.mock('../server/net.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/net.js')>()),
  safeFetchText: vi.fn(async (url: URL, options: { body?: string }) => { delivered.push({ url: url.toString(), body: options.body ?? '' }); return { status: 200, ok: true, text: '{}', truncated: false }; })
}));
vi.mock('../server/federation/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/federation/discovery.js')>()),
  fetchPeerDocument: vi.fn(async (origin: string) => {
    if (!discoveryDoc.current || discoveryDoc.current.url !== origin) throw new Error('unreachable');
    return discoveryDoc.current;
  })
}));

const { canonical, sign: signMessage } = await import('../server/federation/messages.js');
const { fingerprintOf, getIdentity, listPeers, savePeer, setPeerStatus } = await import('../server/federation/identity.js');
const { handleInbound } = await import('../server/federation/inbox.js');
const { applyAction, createPact, pacts } = await import('../server/pacts/service.js');
const { notifications } = await import('../server/notify.js');
const { initPacts } = await import('../server/pacts/index.js');
initPacts();

const savedEnv = { ...process.env };
let server: TestServer | undefined;
beforeEach(async () => {
  await resetStorage();
  delivered.length = 0;
  process.env.FEDERATION_ENABLED = 'true';
  process.env.APP_URL = 'https://home.example.test';
  discoveryDoc.current = { url: remote.url, name: remote.name, publicKey: publicKeyOf(), fingerprint: fingerprintOf(publicKeyOf()) };
});
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); });
afterAll(async () => { await server?.close(); });

async function owner() {
  const user = await freshOwner('Home');
  process.env.OWNER_EMAIL = user.email;
  return user;
}

/** A message from the remote installation, signed with its real key. */
function fromRemote(type: 'hello' | 'pact.propose' | 'pact.update', body: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const message = { v: 1 as const, id: crypto.randomUUID(), type, from: remote.url, to: 'https://home.example.test', ts: Date.now(), body, ...overrides };
  const sig = crypto.sign(null, Buffer.from(canonical(message)), remote.pair.privateKey).toString('base64url');
  return { ...message, sig };
}

const trustRemote = async (userId: string) => (await savePeer(userId, { url: remote.url, name: remote.name, publicKey: publicKeyOf(), status: 'trusted' })).peer;
const propose = (overrides: Record<string, unknown> = {}) => ({ pactId: crypto.randomUUID(), action: 'review the draft', senderOwes: true, fromName: 'Riley', dueAt: new Date(Date.now() + 86_400_000).toISOString(), ...overrides });

describe(`federation inbox (${storageMode})`, () => {
  it('does not exist unless the owner opted in', async () => {
    await owner();
    process.env.FEDERATION_ENABLED = 'false';
    expect((await handleInbound(fromRemote('hello', {}))).status).toBe(404);
  });

  it('turns a signed hello from an unknown installation into a pending request the owner must approve', async () => {
    const user = await owner();
    expect((await handleInbound(fromRemote('hello', {}))).status).toBe(202);
    const peers = await listPeers(user.id);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ status: 'pending_in', url: remote.url });
    expect((await notifications.list(user.id))[0].title).toMatch(/wants to share pacts/);
    await handleInbound(fromRemote('hello', {}));
    expect(await listPeers(user.id)).toHaveLength(1);
  });

  it('rejects a hello signed with a key the claimed address does not publish', async () => {
    const user = await owner();
    const impostor = crypto.generateKeyPairSync('ed25519');
    const message = { v: 1 as const, id: crypto.randomUUID(), type: 'hello' as const, from: remote.url, to: 'https://home.example.test', ts: Date.now(), body: {} };
    const sig = crypto.sign(null, Buffer.from(canonical(message)), impostor.privateKey).toString('base64url');
    expect((await handleInbound({ ...message, sig })).status).toBe(401);
    expect(await listPeers(user.id)).toHaveLength(0);
  });

  it('ignores pacts from installations the owner has not trusted — pending and blocked included', async () => {
    const user = await owner();
    expect((await handleInbound(fromRemote('pact.propose', propose()))).status).toBe(401);
    const peer = await trustRemote(user.id);
    await setPeerStatus(user.id, peer.id, 'pending_in');
    expect((await handleInbound(fromRemote('pact.propose', propose()))).status).toBe(401);
    await setPeerStatus(user.id, peer.id, 'blocked');
    expect((await handleInbound(fromRemote('pact.propose', propose()))).status).toBe(401);
    expect(await pacts.count(user.id)).toBe(0);
  });

  it('creates a mirrored pact from a trusted peer, from the receiver’s point of view', async () => {
    const user = await owner();
    await trustRemote(user.id);
    const body = propose();
    const result = await handleInbound(fromRemote('pact.propose', body));
    expect(result.status).toBe(201);
    const [pact] = await pacts.list(user.id);
    expect(pact).toMatchObject({ direction: 'they_owe', channel: 'federated', otherPerson: 'Riley', action: 'review the draft', remotePactId: body.pactId, status: 'open' });
    expect((await notifications.list(user.id))[0].title).toMatch(/sent you a pact/);
    const inverse = await handleInbound(fromRemote('pact.propose', propose({ senderOwes: false })));
    expect(inverse.status).toBe(201);
    expect((await pacts.list(user.id)).some((item) => item.direction === 'i_owe')).toBe(true);
  });

  it('treats a replayed message as a duplicate and a tampered one as forged', async () => {
    const user = await owner();
    await trustRemote(user.id);
    const message = fromRemote('pact.propose', propose());
    expect((await handleInbound(message)).status).toBe(201);
    const replay = await handleInbound(message);
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect(await pacts.count(user.id)).toBe(1);
    const forged = { ...fromRemote('pact.propose', propose()), body: propose({ action: 'wire me money' }) };
    expect((await handleInbound(forged)).status).toBe(401);
    expect(await pacts.count(user.id)).toBe(1);
  });

  it('refuses stale messages and messages addressed to someone else', async () => {
    const user = await owner();
    await trustRemote(user.id);
    expect((await handleInbound(fromRemote('pact.propose', propose(), { ts: Date.now() - 10 * 60_000 }))).status).toBe(400);
    expect((await handleInbound(fromRemote('pact.propose', propose(), { to: 'https://someone-else.example.test' }))).status).toBe(400);
    expect((await handleInbound({ not: 'an envelope' })).status).toBe(400);
    expect(await pacts.count(user.id)).toBe(0);
  });

  it('applies a peer’s update only for the side it may act as', async () => {
    const user = await owner();
    await trustRemote(user.id);
    const body = propose({ senderOwes: false }); // remote asks us to do something → we are the doer, remote is the requester
    await handleInbound(fromRemote('pact.propose', body));
    const unknown = await handleInbound(fromRemote('pact.update', { pactId: crypto.randomUUID(), action: 'done' }));
    expect(unknown.status).toBe(404);
    const notAllowed = await handleInbound(fromRemote('pact.update', { pactId: body.pactId, action: 'decline' }));
    expect(notAllowed.status).toBe(409);
    const ok = await handleInbound(fromRemote('pact.update', { pactId: body.pactId, action: 'cancel', note: 'No longer needed' }));
    expect(ok.status).toBe(200);
    const [pact] = await pacts.list(user.id);
    expect(pact.status).toBe('canceled');
    expect(pact.events.at(-1)).toMatchObject({ actor: 'peer', action: 'cancel' });
    expect((await notifications.list(user.id))[0].body).toContain('No longer needed');
  });

  it('caps how many open pacts one peer can push', async () => {
    const user = await owner();
    await trustRemote(user.id);
    let last = 201;
    for (let index = 0; index < 52 && last === 201; index += 1) last = (await handleInbound(fromRemote('pact.propose', propose({ action: `task ${index}` })))).status;
    expect(last).toBe(429);
    expect(await pacts.count(user.id)).toBe(50);
  });

  it('never reveals who is trusted: every authentication failure looks the same', async () => {
    const user = await owner();
    const unknown = await handleInbound(fromRemote('pact.propose', propose()));
    await trustRemote(user.id);
    const badSignature = await handleInbound({ ...fromRemote('pact.propose', propose()), sig: 'A'.repeat(86) });
    expect(unknown).toEqual(badSignature);
  });
});

describe(`federation outbound and trust (${storageMode})`, () => {
  it('signs and delivers the owner’s changes to the trusted peer, once', async () => {
    const user = await owner();
    const peer = await trustRemote(user.id);
    const { pact } = await createPact(user.id, { direction: 'i_owe', otherPerson: 'Riley', action: 'send the notes', channel: 'federated', peerId: peer.id });
    const { sendProposal } = await import('../server/federation/outbox.js');
    await sendProposal(pact);
    await sendProposal(pact);
    await drain();
    expect(delivered).toHaveLength(1);
    const envelope = JSON.parse(delivered[0].body);
    expect(delivered[0].url).toBe(`${remote.url}/federation/inbox`);
    expect(envelope).toMatchObject({ type: 'pact.propose', from: 'https://home.example.test', to: remote.url });
    expect(envelope.body).toMatchObject({ pactId: pact.id, senderOwes: true });
    const { sig, ...unsigned } = envelope;
    const ours = (await getIdentity(user.id)).publicKey;
    expect(crypto.verify(null, Buffer.from(canonical(unsigned)), crypto.createPublicKey({ key: Buffer.from(ours, 'base64url'), format: 'der', type: 'spki' }), Buffer.from(sig, 'base64url'))).toBe(true);

    await applyAction(user.id, pact.id, 'owner', 'done');
    await drain();
    expect(delivered).toHaveLength(2);
    expect(JSON.parse(delivered[1].body)).toMatchObject({ type: 'pact.update', body: { pactId: pact.id, action: 'done' } });
  });

  it('tells the owner whether a federated pact was delivered', async () => {
    const user = await owner();
    server = await startApp(user.id);
    const peer = await trustRemote(user.id);
    const { pact } = await createPact(user.id, { direction: 'i_owe', otherPerson: 'Riley', action: 'send the notes', channel: 'federated', peerId: peer.id });
    const { sendProposal } = await import('../server/federation/outbox.js');
    const state = async () => (await (await fetch(`${server!.url}/api/pacts`)).json()).pacts.find((item: { id: string }) => item.id === pact.id).delivery;
    await sendProposal(pact);
    expect(await state()).toBe('queued');
    await drain();
    expect(await state()).toBe('delivered');
    await setPeerStatus(user.id, peer.id, 'blocked');
    await applyAction(user.id, pact.id, 'owner', 'done');
    await drain();
    expect(await state()).toBe('failed');
  });

  it('does not echo a peer’s own update back to it', async () => {
    const user = await owner();
    await trustRemote(user.id);
    const body = propose();
    await handleInbound(fromRemote('pact.propose', body));
    await handleInbound(fromRemote('pact.update', { pactId: body.pactId, action: 'confirm' }));
    await drain();
    expect(delivered).toHaveLength(0);
  });

  it('does not send anything to a peer that is not trusted', async () => {
    const user = await owner();
    const peer = await trustRemote(user.id);
    const { pact } = await createPact(user.id, { direction: 'i_owe', otherPerson: 'Riley', action: 'send the notes', channel: 'federated', peerId: peer.id });
    await setPeerStatus(user.id, peer.id, 'blocked');
    const { sendProposal } = await import('../server/federation/outbox.js');
    await sendProposal(pact);
    await drain();
    expect(delivered).toHaveLength(0);
  });

  it('requires the owner to type the right fingerprint before a peer is trusted', async () => {
    const user = await owner();
    server = await startApp(user.id);
    const added = await fetch(`${server.url}/api/federation/peers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: remote.url }) });
    expect(added.status).toBe(201);
    const { peer } = await added.json();
    expect(peer.status).toBe('pending_out');
    expect(peer.publicKey).toBeUndefined();
    const wrong = await fetch(`${server.url}/api/federation/peers/${peer.id}/trust`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: '0000 0000' }) });
    expect(wrong.status).toBe(400);
    expect((await listPeers(user.id))[0].status).toBe('pending_out');
    const right = await fetch(`${server.url}/api/federation/peers/${peer.id}/trust`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: peer.fingerprint.toUpperCase().replace(/ /g, '') }) });
    expect(right.status).toBe(200);
    expect((await listPeers(user.id))[0].status).toBe('trusted');
  });

  it('refuses to address a pact to a peer that is not trusted', async () => {
    const user = await owner();
    server = await startApp(user.id);
    const peer = (await savePeer(user.id, { url: remote.url, name: remote.name, publicKey: publicKeyOf(), status: 'pending_out' })).peer;
    const post = (peerId: string) => fetch(`${server!.url}/api/pacts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'i_owe', otherPerson: 'Riley', action: 'send notes', peerId }) });
    expect((await post(peer.id)).status).toBe(400);
    expect((await post('made-up-id')).status).toBe(400);
    expect(await pacts.count(user.id)).toBe(0);
    await setPeerStatus(user.id, peer.id, 'trusted');
    expect((await post(peer.id)).status).toBe(201);
    await drain();
    expect(delivered).toHaveLength(1);
  });

  it('serves a public identity only when enabled, and never the private key', async () => {
    const user = await owner();
    server = await startApp(user.id);
    const response = await fetch(`${server.url}/.well-known/orbit-pacts`);
    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(Object.keys(doc).sort()).toEqual(['fingerprint', 'name', 'publicKey', 'url', 'v']);
    expect(doc.fingerprint.replace(/ /g, '')).toBe(fingerprintOf(doc.publicKey).replace(/ /g, ''));
    expect(JSON.stringify(doc)).not.toMatch(/private|encrypted/i);
    process.env.FEDERATION_ENABLED = 'false';
    expect((await fetch(`${server.url}/.well-known/orbit-pacts`)).status).toBe(404);
  });
});
