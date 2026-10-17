import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit } from 'undici';
import { ActionableError } from './diagnostics.js';

/** Dev/test escape hatch only. Never enable on a hosted installation. */
const allowPrivate = () => process.env.SKILLS_ALLOW_PRIVATE_NETWORK === 'true';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
];

function v4Blocked(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => (value & (~0 << (32 - bits)) >>> 0) === (ipv4ToInt(base) & (~0 << (32 - bits)) >>> 0));
}

function expandV6(ip: string): number[] | null {
  const zone = ip.split('%')[0];
  const [head, tail = ''] = zone.split('::');
  const toGroups = (part: string) => (part ? part.split(':') : []);
  const headGroups = toGroups(head);
  const tailGroups = toGroups(tail);
  const embeddedV4 = (groups: string[]) => (groups.length && groups[groups.length - 1].includes('.') ? [...groups.slice(0, -1), ...[...ipv4ToInt(groups[groups.length - 1]).toString(16).padStart(8, '0').match(/.{4}/g)!]] : groups);
  const h = embeddedV4(headGroups);
  const t = embeddedV4(tailGroups);
  const missing = 8 - h.length - t.length;
  if (zone.includes('::') ? missing < 0 : missing !== 0) return null;
  const all = [...h, ...Array(zone.includes('::') ? missing : 0).fill('0'), ...t].map((group) => parseInt(group, 16));
  return all.length === 8 && all.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? all : null;
}

/** True only for addresses that are routable on the public internet. IPv4-mapped/NAT64 forms are unwrapped. */
export function isPublicIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return !v4Blocked(ip);
  if (kind !== 6) return false;
  const groups = expandV6(ip);
  if (!groups) return false;
  const [a, b, , , , f, g, h] = groups;
  const embedded = `${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`;
  if (groups.slice(0, 5).every((group) => group === 0) && (f === 0xffff || f === 0)) return groups.slice(0, 7).every((group) => group === 0) && h <= 1 ? false : !v4Blocked(embedded); // ::ffff:a.b.c.d and ::a.b.c.d
  if (a === 0x64 && b === 0xff9b) return !v4Blocked(embedded); // NAT64
  if (a === 0x2002) return !v4Blocked(`${b >> 8}.${b & 255}.${groups[2] >> 8}.${groups[2] & 255}`); // 6to4
  if ((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xff00) === 0xff00) return false; // ULA, link-local, multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  return !groups.every((group) => group === 0) && !(groups.slice(0, 7).every((group) => group === 0) && h === 1);
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** DNS lookup that refuses to resolve to a non-public address. The connection then uses the validated IP. */
export function safeLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses as dns.LookupAddress[];
    if (!allowPrivate() && list.some((entry) => !isPublicIp(entry.address))) {
      const blocked = Object.assign(new Error(`Blocked: ${hostname} resolves to a private or reserved address`), { code: 'EBLOCKED' }) as NodeJS.ErrnoException;
      return callback(blocked, '');
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

const agent = new Agent({ connect: { lookup: safeLookup as never }, headersTimeout: 15_000, bodyTimeout: 20_000 });

/** Validates a URL a skill or MCP server may contact. */
export function assertAllowedUrl(raw: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ActionableError('That is not a valid web address.', { action: 'Check the skill definition.', code: 'bad_url' });
  }
  const loopbackDev = allowPrivate() && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopbackDev) throw new ActionableError('Skills may only contact https addresses.', { action: 'Use an https URL.', code: 'not_https' });
  if (url.username || url.password) throw new ActionableError('Addresses with embedded credentials are not allowed.', { action: 'Store credentials as skill secrets instead.', code: 'bad_url' });
  const host = url.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, '')) && !loopbackDev && !isPublicIp(host.replace(/^\[|\]$/g, ''))) throw new ActionableError('That address is private or reserved.', { action: 'Skills can only contact public internet hosts.', code: 'private_address' });
  if (!allowedHosts.map((entry) => entry.toLowerCase()).includes(host)) throw new ActionableError(`${host} is not on this skill’s approved domain list.`, { action: 'Review the skill’s domains and approve it again if it should reach this host.', code: 'domain_blocked' });
  return url;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  maxBytes?: number;
}

/**
 * fetch with: validated DNS (no private ranges, no rebinding), no redirects, a hard timeout and a response
 * size cap. Returns the status and a truncated text body.
 */
export async function safeFetchText(url: URL, options: SafeFetchOptions = {}): Promise<{ status: number; ok: boolean; text: string; truncated: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await undiciFetch(url, { method: options.method ?? 'GET', headers: options.headers, body: options.body, redirect: 'manual', signal: controller.signal, dispatcher: agent } as RequestInit);
    if (response.status >= 300 && response.status < 400) throw new ActionableError('The service tried to redirect. Skills do not follow redirects.', { action: 'Update the skill to use the final address.', code: 'redirect_blocked' });
    const max = options.maxBytes ?? 256 * 1024;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { truncated = true; await reader.cancel(); break; }
      chunks.push(value);
    }
    return { status: response.status, ok: response.ok, text: Buffer.concat(chunks).toString('utf8'), truncated };
  } finally {
    clearTimeout(timer);
  }
}

/** A fetch implementation with the same protections, for SDKs that accept a custom fetch (MCP). */
export function safeFetchFor(allowedHosts: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    assertAllowedUrl(raw, allowedHosts);
    return undiciFetch(raw, { ...(init as RequestInit), redirect: 'error', dispatcher: agent } as RequestInit);
  }) as unknown as typeof fetch;
}
