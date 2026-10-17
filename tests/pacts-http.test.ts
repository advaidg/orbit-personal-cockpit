import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { startApp, type TestServer } from './httpApp.js';
import { createPact, getPact, rotateLink } from '../server/pacts/service.js';
import { getCommitment } from '../server/agent/commitments.js';
import type { User } from '../server/types.js';

beforeEach(resetStorage);
const savedEnv = { ...process.env };
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); });

let server: TestServer | undefined;
afterAll(async () => { await server?.close(); });

async function setup(overrides: Partial<Parameters<typeof createPact>[1]> = {}): Promise<{ owner: User; token: string; id: string; base: string }> {
  const owner = await freshOwner('Alex');
  await server?.close();
  server = await startApp(owner.id);
  const { pact, token } = await createPact(owner.id, { direction: 'they_owe', otherPerson: 'Maya Chen', action: 'send the revised deck', dueAt: new Date(Date.now() + 86_400_000).toISOString(), otherEmail: 'maya@private.example', ...overrides });
  return { owner, token: token!, id: pact.id, base: server.url };
}

const post = (url: string, fields: Record<string, string>) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });

describe(`public pact page (${storageMode})`, () => {
  it('shows the promise, and only the promise, with privacy-preserving headers', async () => {
    const { owner, token, base } = await setup();
    const response = await fetch(`${base}/p/${token}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('send the revised deck');
    expect(html).toContain('Alex');
    expect(html).not.toContain(owner.email);
    expect(html).not.toContain('maya@private.example');
    expect(response.headers.get('x-robots-tag')).toMatch(/noindex/);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(html).not.toMatch(/<script/i);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('escapes anything the owner or an email put into the promise', async () => {
    const { token, base } = await setup({ action: '<img src=x onerror=alert(1)> & "quotes"', otherPerson: '<b>Maya</b>' });
    const html = await (await fetch(`${base}/p/${token}`)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Maya</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
  });

  it('answers wrong, expired and revoked links with the same page and changes nothing', async () => {
    const { owner, token, id, base } = await setup();
    const wrong = await fetch(`${base}/p/${token.slice(0, -3)}abc`);
    const nowhere = await fetch(`${base}/p/not-a-token`);
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).toBe(await nowhere.text());
    expect((await post(`${base}/p/${token.slice(0, -3)}abc`, { action: 'done' })).status).toBe(404);
    expect((await getPact(owner.id, id))?.status).toBe('open');
    await rotateLink(owner.id, id);
    expect((await fetch(`${base}/p/${token}`)).status).toBe(404);
  });

  it('applies an action once, redirects, and a reload does not repeat it', async () => {
    const { owner, token, id, base } = await setup();
    const response = await post(`${base}/p/${token}`, { action: 'done', note: 'All sent' });
    expect(response.status).toBe(303);
    const location = response.headers.get('location')!;
    expect(location).toBe(`/p/${token}?done=done`);
    const page = await (await fetch(`${base}${location}`)).text();
    expect(page).toContain('Marked as done');
    expect(page).toContain('Closed');
    expect((await getPact(owner.id, id))?.status).toBe('done');
    expect((await getCommitment(owner.id, (await getPact(owner.id, id))!.commitmentId!))?.status).toBe('resolved');
    const again = await post(`${base}/p/${token}`, { action: 'done' });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('already done');
  });

  it('records a requested new date and a note', async () => {
    const { owner, token, id, base } = await setup();
    const date = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    expect((await post(`${base}/p/${token}`, { action: 'reschedule', date, note: 'Travelling' })).status).toBe(303);
    const pact = (await getPact(owner.id, id))!;
    expect(pact.dueAt?.slice(0, 10)).toBe(date);
    expect(pact.events.at(-1)).toMatchObject({ actor: 'counterparty', action: 'reschedule', note: 'Travelling' });
  });

  it('refuses actions that do not fit the side, unknown actions and oversize bodies', async () => {
    const { token, base } = await setup();
    expect((await post(`${base}/p/${token}`, { action: 'cancel' })).status).toBe(400);
    expect((await post(`${base}/p/${token}`, { action: 'delete-everything' })).status).toBe(400);
    expect((await post(`${base}/p/${token}`, { action: 'reschedule' })).status).toBe(400);
    const huge = await post(`${base}/p/${token}`, { action: 'confirm', note: 'x'.repeat(50_000) });
    expect(huge.status).toBe(413);
  });

  it('is switched off when pacts are disabled', async () => {
    const { token, base } = await setup();
    process.env.PACTS_ENABLED = 'false';
    expect((await fetch(`${base}/p/${token}`)).status).toBe(404);
  });

  it('rate limits a single link', async () => {
    const { token, base } = await setup();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 45; attempt += 1) statuses.push((await fetch(`${base}/p/${token}`)).status);
    expect(statuses).toContain(429);
  });
});

describe(`owner pact API (${storageMode})`, () => {
  it('creates a pact, returns the link once with a ready message, and never exposes the hash', async () => {
    const owner = await freshOwner('Alex');
    server = await startApp(owner.id);
    const created = await fetch(`${server.url}/api/pacts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'i_owe', otherPerson: 'Dana', action: 'send the invoice', dueAt: new Date(Date.now() + 86_400_000).toISOString() }) });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.url).toMatch(/\/p\/[\w-]+\.[\w-]+$/);
    expect(body.message).toContain(body.url);
    expect(body.message).toContain('Alex');
    expect(JSON.stringify(body.pact)).not.toContain('linkHash');
    expect(body.pact.link.active).toBe(true);
    const list = await (await fetch(`${server.url}/api/pacts`)).json();
    expect(JSON.stringify(list)).not.toContain('linkHash');
    expect(list.pacts).toHaveLength(1);
    expect(list.pacts[0].link.active).toBe(true);
    const revoked = await (await fetch(`${server.url}/api/pacts/${body.pact.id}/link`, { method: 'DELETE' })).json();
    expect(revoked.pact.link.active).toBe(false);
    expect((await fetch(body.url.replace(/^https?:\/\/[^/]+/, server.url))).status).toBe(404);
  });

  it('validates input and lets the owner act on or delete a pact', async () => {
    const owner = await freshOwner('Alex');
    server = await startApp(owner.id);
    const bad = await fetch(`${server.url}/api/pacts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'sideways', otherPerson: '', action: '' }) });
    expect(bad.status).toBe(400);
    const { pact } = await createPact(owner.id, { direction: 'they_owe', otherPerson: 'Sam', action: 'reply' });
    const done = await (await fetch(`${server.url}/api/pacts/${pact.id}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'done' }) })).json();
    expect(done.pact.status).toBe('done');
    expect((await fetch(`${server.url}/api/pacts/${pact.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${server.url}/api/pacts/${pact.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});
