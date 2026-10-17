import crypto from 'node:crypto';
import { Collection, type Owned } from '../collection.js';
import { decrypt, encrypt } from '../crypto.js';
import { publicBaseUrl } from '../pacts/config.js';

export type PeerStatus = 'pending_out' | 'pending_in' | 'trusted' | 'blocked';

export interface Identity extends Owned {
  kind: 'identity';
  publicKey: string;
  /** PKCS#8 private key, AES-GCM encrypted with APP_ENCRYPTION_KEY. */
  encryptedPrivateKey: string;
}

export interface Peer extends Owned {
  kind: 'peer';
  /** Origin of the other installation, for example https://orbit.example.com. */
  url: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  status: PeerStatus;
  lastSeenAt?: string;
  updatedAt: string;
}

export interface Seen extends Owned {
  kind: 'seen';
}

export type FederationDoc = Identity | Peer | Seen;

export const federation = new Collection<FederationDoc>('federation');

const IDENTITY_ID = 'identity';

/** Short, human-comparable digest of a public key (eight groups of four hex characters). */
export function fingerprintOf(publicKey: string): string {
  const hex = crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 32);
  return (hex.match(/.{4}/g) ?? []).join(' ');
}

export async function getIdentity(userId: string): Promise<Identity> {
  const existing = (await federation.get(userId, IDENTITY_ID)) as Identity | null;
  if (existing) return existing;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const identity: Identity = {
    id: IDENTITY_ID, userId, kind: 'identity', createdAt: new Date().toISOString(),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    encryptedPrivateKey: encrypt(privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'))
  };
  const { item } = await federation.insert(identity, 'identity');
  return item as Identity;
}

export function privateKeyOf(identity: Identity): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.from(decrypt<string>(identity.encryptedPrivateKey), 'base64url'), format: 'der', type: 'pkcs8' });
}

export function publicKeyObject(publicKey: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
}

export async function discoveryDocument(userId: string, ownerName: string) {
  const identity = await getIdentity(userId);
  return { v: 1, url: publicBaseUrl(), name: ownerName.slice(0, 80), publicKey: identity.publicKey, fingerprint: fingerprintOf(identity.publicKey) };
}

export async function listPeers(userId: string): Promise<Peer[]> {
  return (await federation.list(userId, { where: { kind: 'peer' } })) as Peer[];
}

export async function findPeerByUrl(userId: string, url: string): Promise<Peer | null> {
  return ((await federation.findByUniqueKey(userId, `peer:${url}`)) as Peer | null) ?? null;
}

export async function getPeer(userId: string, id: string): Promise<Peer | null> {
  const doc = await federation.get(userId, id);
  return doc?.kind === 'peer' ? doc : null;
}

export async function savePeer(userId: string, input: { url: string; name: string; publicKey: string; status: PeerStatus }): Promise<{ peer: Peer; created: boolean }> {
  const now = new Date().toISOString();
  const peer: Peer = { id: crypto.randomUUID(), userId, kind: 'peer', createdAt: now, updatedAt: now, url: input.url, name: input.name.slice(0, 80) || input.url, publicKey: input.publicKey, fingerprint: fingerprintOf(input.publicKey), status: input.status };
  const { item, created } = await federation.insert(peer, `peer:${input.url}`);
  return { peer: item as Peer, created };
}

export async function setPeerStatus(userId: string, id: string, status: PeerStatus): Promise<Peer | null> {
  const peer = await getPeer(userId, id);
  if (!peer) return null;
  return (await federation.update(userId, id, { status, updatedAt: new Date().toISOString() } as Partial<FederationDoc>)) as Peer | null;
}

export async function removePeer(userId: string, id: string): Promise<boolean> {
  const peer = await getPeer(userId, id);
  return peer ? federation.delete(userId, id) : false;
}

/** Remembers a message id so a replayed message is recognised. Returns false when it was seen before. */
export async function markSeen(userId: string, messageId: string): Promise<boolean> {
  const doc: Seen = { id: crypto.randomUUID(), userId, kind: 'seen', createdAt: new Date().toISOString() };
  return (await federation.insert(doc, `seen:${messageId}`)).created;
}
