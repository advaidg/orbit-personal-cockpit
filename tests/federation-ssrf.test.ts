import { afterEach, describe, expect, it, vi } from 'vitest';

const { reply } = vi.hoisted(() => ({ reply: { current: { status: 200, ok: true, text: '{}', truncated: false } } }));
vi.mock('../server/net.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../server/net.js')>()), safeFetchText: vi.fn(async () => reply.current) }));

const { fetchPeerDocument, normalizeOrigin } = await import('../server/federation/discovery.js');
const { fingerprintOf } = await import('../server/federation/identity.js');

const savedEnv = { ...process.env };
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); });

describe('peer addresses', () => {
  it('normalises to a bare origin and refuses credentials', () => {
    expect(normalizeOrigin('Orbit.Example.com/some/path?x=1')).toBe('https://orbit.example.com');
    expect(() => normalizeOrigin('https://user:pw@orbit.example.com')).toThrow(/credentials/);
    expect(() => normalizeOrigin('http://')).toThrow(/valid web address/);
  });

  it.each(['https://127.0.0.1', 'https://169.254.169.254', 'https://10.0.0.5', 'https://[::1]', 'http://orbit.example.com'])('refuses to contact %s', async (origin) => {
    await expect(fetchPeerDocument(normalizeOrigin(origin))).rejects.toThrow();
  });

  it('refuses to peer with itself', async () => {
    process.env.APP_URL = 'https://home.example.test';
    await expect(fetchPeerDocument('https://home.example.test')).rejects.toThrow(/this installation/);
  });

  it('refuses an identity that claims a different address or carries a mismatched fingerprint', async () => {
    const key = 'A'.repeat(44);
    reply.current = { status: 200, ok: true, truncated: false, text: JSON.stringify({ v: 1, url: 'https://evil.example.test', name: 'x', publicKey: key, fingerprint: fingerprintOf(key) }) };
    await expect(fetchPeerDocument('https://good.example.test')).rejects.toThrow(/different address/);
    reply.current = { status: 200, ok: true, truncated: false, text: JSON.stringify({ v: 1, url: 'https://good.example.test', name: 'x', publicKey: key, fingerprint: '0000 0000' }) };
    await expect(fetchPeerDocument('https://good.example.test')).rejects.toThrow(/fingerprint/);
    reply.current = { status: 200, ok: true, truncated: false, text: 'not json' };
    await expect(fetchPeerDocument('https://good.example.test')).rejects.toThrow(/valid Orbit identity/);
    reply.current = { status: 404, ok: false, truncated: false, text: '' };
    await expect(fetchPeerDocument('https://good.example.test')).rejects.toThrow(/did not answer/);
  });

  it('accepts a well-formed identity at the requested address', async () => {
    const key = 'A'.repeat(44);
    reply.current = { status: 200, ok: true, truncated: false, text: JSON.stringify({ v: 1, url: 'https://good.example.test', name: 'Good', publicKey: key, fingerprint: fingerprintOf(key) }) };
    await expect(fetchPeerDocument('https://good.example.test')).resolves.toMatchObject({ url: 'https://good.example.test', name: 'Good' });
  });
});
