import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { assertAllowedUrl, isPublicIp, safeFetchText } from '../server/net.js';

afterEach(() => { delete process.env.SKILLS_ALLOW_PRIVATE_NETWORK; });

describe('SSRF protection', () => {
  it.each([
    ['127.0.0.1', false], ['10.1.2.3', false], ['172.16.0.1', false], ['172.32.0.1', true], ['192.168.1.1', false], ['169.254.169.254', false],
    ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false], ['8.8.8.8', true], ['1.1.1.1', true], ['93.184.216.34', true],
    ['::1', false], ['::', false], ['fe80::1', false], ['fc00::1', false], ['fd12:3456::1', false], ['ff02::1', false], ['2001:db8::1', false],
    ['::ffff:127.0.0.1', false], ['::ffff:7f00:1', false], ['::ffff:8.8.8.8', true], ['64:ff9b::7f00:1', false], ['2606:4700:4700::1111', true], ['not-an-ip', false]
  ])('isPublicIp(%s) → %s', (ip, expected) => expect(isPublicIp(ip)).toBe(expected));

  it('only allows https URLs on the approved host list', () => {
    expect(() => assertAllowedUrl('http://api.example.com/x', ['api.example.com'])).toThrow(/https/);
    expect(() => assertAllowedUrl('https://evil.example.net/x', ['api.example.com'])).toThrow(/approved domain/);
    expect(() => assertAllowedUrl('https://user:pw@api.example.com/x', ['api.example.com'])).toThrow(/credentials/);
    expect(() => assertAllowedUrl('https://169.254.169.254/latest/meta-data', ['169.254.169.254'])).toThrow(/private/);
    expect(assertAllowedUrl('https://API.example.com/x?y=1', ['api.example.com']).hostname).toBe('api.example.com');
  });

  it('refuses to connect to loopback even when the host is allow-listed', async () => {
    const server = http.createServer((_req, res) => res.end('secret')).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    process.env.SKILLS_ALLOW_PRIVATE_NETWORK = 'false';
    await expect(safeFetchText(new URL(`http://localhost:${port}/`))).rejects.toThrow();
    server.close();
  });

  it('can reach loopback only with the explicit dev override, without following redirects, and caps response size', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/' }).end(); return; }
      if (req.url === '/big') { res.end('x'.repeat(600_000)); return; }
      res.end('ok');
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    process.env.SKILLS_ALLOW_PRIVATE_NETWORK = 'true';
    expect((await safeFetchText(new URL(`http://localhost:${port}/`))).text).toBe('ok');
    await expect(safeFetchText(new URL(`http://localhost:${port}/redirect`))).rejects.toThrow(/redirect/);
    const big = await safeFetchText(new URL(`http://localhost:${port}/big`));
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBeLessThanOrEqual(256 * 1024);
    server.close();
  });
});
