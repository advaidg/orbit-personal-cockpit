import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { startApp, type TestServer } from './httpApp.js';
import { events, requests } from '../server/guard/store.js';
import { usageToday } from '../server/guard/usage.js';
import { resolveRequest } from '../server/guard/engine.js';
import { initGuard } from '../server/guard/index.js';
import { setTelegramApi, type TelegramApi } from '../server/telegram/api.js';

initGuard();

const quietTelegram: TelegramApi = { async send() {}, async answerCallback() {}, async getUpdates() { return []; }, async botUsername() { return 'b'; }, async verifyToken() { return { username: 'b' }; } };
const savedEnv = { ...process.env };
let server: TestServer | undefined;
let restore: Array<() => void> = [];
const tmp: string[] = [];
beforeEach(async () => { await resetStorage(); restore = [setTelegramApi(quietTelegram)]; process.env.GUARD_POLL_MS = '15'; process.env.GUARD_MIN_WAIT_SECONDS = '0.3'; });
afterEach(() => {
  restore.forEach((fn) => fn());
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
afterAll(async () => { await server?.close(); for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true }); });

/** A local port nothing is listening on, for "Orbit is down" tests. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function app() {
  const owner = await freshOwner('Dev');
  await server?.close();
  server = await startApp(owner.id);
  const created = await (await fetch(`${server.url}/api/guard/agents`, json('POST', { name: 'Claude Code' }))).json();
  return { owner, url: server.url, token: created.token as string, agent: created.agent, install: created.install };
}

const hook = (url: string, token: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/guard/v1/hook`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
const preToolUse = (command: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/home/dev/project', tool_name: 'Bash', tool_input: { command }, tool_use_id: `u-${Math.random()}`, ...extra });

describe(`the hook endpoint (${storageMode})`, () => {
  it('answers in the shape Claude Code expects', async () => {
    const { url, token } = await app();
    const allowed = await (await hook(url, token, preToolUse('git status'))).json();
    expect(allowed).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Orbit judged this safe.' } });
    const denied = await (await hook(url, token, preToolUse('rm -rf /'))).json();
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await (await hook(url, token, preToolUse('mystery-tool'))).json()).toEqual({});
  });

  it('turns away a bad token without saying why, and ignores everything that is not a pre-tool event', async () => {
    const { url, token } = await app();
    for (const bad of ['', 'nope', 'og_wrong', `${token}x`, 'x'.repeat(500)]) expect((await hook(url, bad, preToolUse('ls'))).status, bad).toBe(401);
    expect((await fetch(`${url}/guard/v1/hook`, json('POST', preToolUse('ls')))).status).toBe(401);
    expect(await (await hook(url, token, { hook_event_name: 'PostToolUse', tool_name: 'Bash' })).json()).toEqual({});
    expect(await (await hook(url, token, { not: 'an event' })).json()).toEqual({});
    expect(await (await hook(url, token, { tool_name: 42 })).json()).toEqual({});
  });

  it('refuses oversized and malformed bodies', async () => {
    const { url, token } = await app();
    const big = await hook(url, token, preToolUse('x'.repeat(600_000)));
    expect(big.status).toBe(413);
    const broken = await fetch(`${url}/guard/v1/hook`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{nope' });
    expect(broken.status).toBe(400);
  });

  it('holds a risky call until the owner answers through the API', async () => {
    const { owner, url, token } = await app();
    const waiting = hook(url, token, preToolUse('git push --force origin main')).then((response) => response.json());
    for (let i = 0; i < 200 && !(await requests.count(owner.id, { status: 'pending' })); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const overview = await (await fetch(`${url}/api/guard`)).json();
    expect(overview.pending).toHaveLength(1);
    expect(overview.pending[0]).toMatchObject({ summary: 'git push --force origin main', agentName: 'Claude Code', category: 'push' });
    expect(JSON.stringify(overview)).not.toMatch(/tokenHash|subjectHash/);
    const answered = await fetch(`${url}/api/guard/requests/${overview.pending[0].id}/resolve`, json('POST', { decision: 'approved' }));
    expect(answered.status).toBe(200);
    expect((await waiting).hookSpecificOutput.permissionDecision).toBe('allow');
    expect((await fetch(`${url}/api/guard/requests/${overview.pending[0].id}/resolve`, json('POST', { decision: 'denied' }))).status).toBe(409);
  });
});

describe(`the owner API (${storageMode})`, () => {
  it('registers an agent, shows the token once, and gives a ready-to-paste install', async () => {
    const { url, token, install, agent } = await app();
    expect(token).toMatch(/^og_[\w-]{20,}$/);
    expect(install.download).toContain('/guard/hook.mjs');
    const settings = JSON.parse(install.settings);
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: '*', hooks: [{ type: 'command', command: 'node ~/.orbit/orbit-guard.mjs' }] });
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBeGreaterThan(180);
    expect(install.settings).not.toContain(token);
    const overview = await (await fetch(`${url}/api/guard`)).text();
    expect(overview).not.toContain(token);
    expect(JSON.parse(overview).agents[0]).toMatchObject({ id: agent.id, name: 'Claude Code', usage: { weighted: 0 } });
  });

  it('pauses, budgets and revokes an agent', async () => {
    const { url, token, agent } = await app();
    await fetch(`${url}/api/guard/agents/${agent.id}`, json('PATCH', { paused: true }));
    expect((await (await hook(url, token, preToolUse('ls'))).json()).hookSpecificOutput.permissionDecision).toBe('deny');
    await fetch(`${url}/api/guard/agents/${agent.id}`, json('PATCH', { paused: false, dailyTokenBudget: 20_000 }));
    expect((await (await fetch(`${url}/api/guard`)).json()).agents[0].dailyTokenBudget).toBe(20_000);
    await fetch(`${url}/api/guard/agents/${agent.id}`, json('PATCH', { dailyTokenBudget: null }));
    expect((await (await fetch(`${url}/api/guard`)).json()).agents[0].dailyTokenBudget).toBeFalsy();
    expect((await fetch(`${url}/api/guard/agents/${agent.id}`, json('PATCH', { dailyTokenBudget: 5 }))).status).toBe(400);
    expect((await fetch(`${url}/api/guard/agents/${agent.id}`, json('DELETE'))).status).toBe(204);
    expect((await hook(url, token, preToolUse('ls'))).status).toBe(401);
    expect((await fetch(`${url}/api/guard/agents/${agent.id}`, json('DELETE'))).status).toBe(404);
  });

  it('manages rules, refusing dangerous ones, and lets you try a command without running it', async () => {
    const { owner, url } = await app();
    const post = (path: string, body: unknown) => fetch(`${url}/api/guard${path}`, json('POST', body));
    expect((await post('/rules', { tool: 'Bash', match: 'glob', value: '*', action: 'allow' })).status).toBe(400);
    const made = await post('/rules', { tool: 'Bash', match: 'glob', value: 'npm run deploy*', action: 'ask', note: 'Ask me before deploying' });
    expect(made.status).toBe(201);
    expect((await post('/rules', { tool: 'Bash', match: 'glob', value: 'npm run deploy*', action: 'ask' })).status).toBe(200);
    const exact = await (await post('/rules', { tool: 'Bash', match: 'exact', value: 'make release', action: 'allow', project: '/home/dev/project' })).json();
    expect(exact.rule.valueHash).toBeUndefined();
    const list = await (await fetch(`${url}/api/guard/rules`)).json();
    expect(list.rules).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain('valueHash');
    const tried = await (await post('/try', { tool: 'Bash', command: 'git push --force' })).json();
    expect(tried).toMatchObject({ verdict: 'ask', category: 'push', strictness: 'balanced' });
    expect((await post('/try', { tool: 'Bash', command: 'rm -rf /' })).status).toBe(200);
    expect(await events.count(owner.id)).toBe(0);
    expect((await fetch(`${url}/api/guard/rules/${list.rules[0].id}`, json('DELETE'))).status).toBe(204);
  });

  it('saves settings with sensible limits', async () => {
    const { url } = await app();
    const put = (body: unknown) => fetch(`${url}/api/guard/settings`, json('PUT', body));
    expect((await put({ strictness: 'strict', waitSeconds: 60, onTimeout: 'deny' })).status).toBe(200);
    expect((await put({ waitSeconds: 1 })).status).toBe(400);
    expect((await put({ waitSeconds: 9999 })).status).toBe(400);
    expect((await put({ strictness: 'reckless' })).status).toBe(400);
    const settings = (await (await put({ usdPerMillion: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } })).json()).settings;
    expect(settings).toMatchObject({ strictness: 'strict', waitSeconds: 60, onTimeout: 'deny', usdPerMillion: { output: 15 } });
    expect((await (await put({ usdPerMillion: null })).json()).settings.usdPerMillion).toBeNull();
  });

  it('serves the hook program without any secret in it', async () => {
    const { url, token } = await app();
    const response = await fetch(`${url}/guard/hook.mjs`);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
    const script = await response.text();
    expect(script).toContain('/guard/v1/hook');
    expect(script).not.toContain(token);
  });
});

/** Runs the real downloaded hook program the way Claude Code would. */
async function runHook(url: string, token: string | undefined, event: unknown, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-hook-'));
  tmp.push(dir);
  const file = path.join(dir, 'orbit-guard.mjs');
  // The program is always downloaded from the running Orbit; ORBIT_URL may point somewhere else (or nowhere).
  fs.writeFileSync(file, await (await fetch(`${server!.url}/guard/hook.mjs`)).text());
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { env: { PATH: process.env.PATH ?? '', TMPDIR: dir, ORBIT_URL: url, ...(token ? { ORBIT_GUARD_TOKEN: token } : {}), ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
  });
}

describe(`the real hook program (${storageMode})`, () => {
  it('prints Orbit’s answer for Claude Code, and nothing when Orbit has no opinion', async () => {
    const { url, token } = await app();
    const allowed = await runHook(url, token, preToolUse('git status'));
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
    const none = await runHook(url, token, preToolUse('mystery-tool'));
    expect(none).toMatchObject({ code: 0, stdout: '' });
    const denied = await runHook(url, token, preToolUse('rm -rf /'));
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('falls back to Claude Code’s own prompts — never to “allow” — when Orbit cannot be used', async () => {
    const { url, token } = await app();
    const noToken = await runHook(url, undefined, preToolUse('git status'));
    expect(noToken).toMatchObject({ code: 0, stdout: '' });
    expect(noToken.stderr).toMatch(/not set/);
    const badToken = await runHook(url, 'og_wrongwrongwrongwrongwrong', preToolUse('git status'));
    expect(badToken).toMatchObject({ code: 0, stdout: '' });
    expect(badToken.stderr).toMatch(/401/);
    const unreachable = await runHook(`http://127.0.0.1:${await closedPort()}`, token, preToolUse('git status'));
    expect(unreachable).toMatchObject({ code: 0, stdout: '' });
    expect(unreachable.stderr).toMatch(/could not reach Orbit/);
    const garbage = await runHook(url, token, 'this is not json');
    expect(garbage).toMatchObject({ code: 0, stdout: '' });
  });

  it('can be told to block instead when Orbit is unreachable', async () => {
    const { token } = await app();
    const blocked = await runHook(`http://127.0.0.1:${await closedPort()}`, token, preToolUse('git status'), { ORBIT_GUARD_FAIL: 'deny' });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toMatch(/refusing/);
  });

  it('reports token use from the transcript incrementally and sends nothing else from it', async () => {
    const { owner, url, token, agent } = await app();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-transcript-'));
    tmp.push(dir);
    const transcript = path.join(dir, 'session.jsonl');
    const line = (id: string, input: number, output: number, read: number, write: number, text = 'SECRET CONVERSATION TEXT') => `${JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write } } })}\n`;
    fs.writeFileSync(transcript, line('m1', 100, 40, 5000, 300) + line('m1', 100, 60, 5000, 300) + line('m2', 50, 20, 6000, 0));
    const event = preToolUse('git status', { transcript_path: transcript, session_id: 'sess-1' });
    const env = { TMPDIR: dir };
    expect((await runHook(url, token, event, env)).code).toBe(0);
    // m1 appears twice (streaming); only its latest usage counts.
    expect((await usageToday(owner.id, agent.id)).totals).toEqual({ input: 150, output: 80, cacheRead: 11000, cacheWrite: 300 });
    fs.appendFileSync(transcript, line('m3', 10, 5, 100, 0));
    expect((await runHook(url, token, event, env)).code).toBe(0);
    expect((await usageToday(owner.id, agent.id)).totals).toEqual({ input: 160, output: 85, cacheRead: 11100, cacheWrite: 300 });
    expect(JSON.stringify(await events.list(owner.id))).not.toContain('SECRET CONVERSATION TEXT');
  });
});
