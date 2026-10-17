import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { freshOwner, resetStorage, storageMode } from './helpers.js';
import { drain, runCalls } from './agentHelpers.js';
import { approveProposal } from '../server/agent/proposals.js';
import { getTool } from '../server/agent/tools/registry.js';
import { deleteSkill, disableSkill, enableSkill, getSkill, installSkill, manifestChecksum, parseManifest, publicSkill, setSecrets, listSkills, setAllowedDomains, unregisterSkillTools } from '../server/agent/skills.js';
import { validateArguments } from '../server/agent/mcp.js';
import { loadEnabledSkills } from '../server/agent/skillsBoot.js';
import { proposalStore, executionStore } from '../server/agent/stores.js';

beforeEach(resetStorage);
const saved = { ...process.env };
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: 'weather-lookup', name: 'Weather lookup', description: 'Looks up the forecast for a city.', version: '1.0.0',
  env: [{ name: 'WEATHER_KEY', description: 'API key', required: true }],
  permissions: { read: ['Forecast for a city you name'], write: [] }, domains: ['api.weather.example.com'],
  tools: [{ name: 'forecast', description: 'Get a forecast', method: 'GET', url: 'https://api.weather.example.com/forecast/{city}', params: { city: { type: 'string', description: 'City', maxLength: 60 } }, headers: { Authorization: 'Bearer {{env.WEATHER_KEY}}' }, effect: 'read' }],
  ...overrides
});

describe('manifest validation', () => {
  it('rejects tools that contact undeclared hosts or reference undeclared secrets', () => {
    expect(() => parseManifest(manifest({ domains: ['other.example.com'] }))).toThrow(/not listed in domains/);
    expect(() => parseManifest(manifest({ env: [] }))).toThrow(/undeclared secret/);
    expect(() => parseManifest(manifest({ tools: [{ name: 'x1', description: 'x', url: 'https://api.weather.example.com/{missing}' }] }))).toThrow(/does not declare/);
    expect(() => parseManifest(manifest({ domains: ['*.example.com'] }))).toThrow();
    expect(() => parseManifest({ id: 'x' })).toThrow(/not valid/);
  });

  it('checksums canonically and rejects a tampered package', () => {
    const a = manifest();
    const reordered = JSON.parse(JSON.stringify(a), (_k, v) => v);
    expect(manifestChecksum(parseManifest(a).manifest)).toBe(manifestChecksum(parseManifest(reordered).manifest));
    const good = manifestChecksum(parseManifest(a).manifest);
    expect(parseManifest(a, good).verified).toBe(true);
    expect(parseManifest(a).verified).toBe(false);
    expect(() => parseManifest(manifest({ description: 'Changed after publishing.' }), good)).toThrow(/checksum/i);
  });
});

describe(`skill lifecycle (${storageMode})`, () => {
  it('is disabled by default and cannot be installed or called', async () => {
    const owner = await freshOwner();
    const { proposals } = await runCalls(owner.id, [{ tool: 'install_skill', input: { manifest: manifest() }, reason: 'test' }]);
    expect(proposals[0].status).toBe('blocked');
    expect(proposals[0].blockedReason).toMatch(/disabled/);
    await expect(installSkill(owner.id, parseManifest(manifest()).manifest, 'x', false)).rejects.toThrow(/disabled/);
    expect(await listSkills(owner.id)).toHaveLength(0);
  });

  it('installs only after approval, shows a permission review, and starts disabled', async () => {
    process.env.SKILLS_ENABLED = 'true';
    const owner = await freshOwner();
    const sha = manifestChecksum(parseManifest(manifest()).manifest);
    const { proposals } = await runCalls(owner.id, [{ tool: 'install_skill', input: { manifest: manifest(), sha256: sha }, reason: 'test' }]);
    expect(proposals[0].status).toBe('pending');
    expect(proposals[0].alwaysAllowable).toBe(false);
    expect(proposals[0].preview.description).toMatch(/matches the publisher/);
    expect(proposals[0].preview.description).toMatch(/Secrets needed: WEATHER_KEY/);
    expect(proposals[0].preview.services).toEqual(['api.weather.example.com']);
    expect(await getSkill(owner.id, 'weather-lookup')).toBeNull();
    await expect(approveProposal(owner.id, proposals[0].id, { alwaysAllow: true })).rejects.toThrow(/always needs approval/);
    await approveProposal(owner.id, proposals[0].id);
    await drain();
    const skill = (await getSkill(owner.id, 'weather-lookup'))!;
    expect(skill).toMatchObject({ status: 'installed', verified: true });
    expect(getTool('skill.weather-lookup.forecast')).toBeUndefined();
  });

  it('requires secrets, a checksum acknowledgement and approval before enabling, and never exposes secret values', async () => {
    process.env.SKILLS_ENABLED = 'true';
    const owner = await freshOwner();
    const parsed = parseManifest(manifest());
    await installSkill(owner.id, parsed.manifest, parsed.checksum, false);
    await expect(enableSkill(owner.id, 'weather-lookup')).rejects.toThrow(/without a checksum/);
    await expect(enableSkill(owner.id, 'weather-lookup', { acknowledgeUnverified: true })).rejects.toThrow(/secret/);
    await expect(setSecrets(owner.id, 'weather-lookup', { UNDECLARED: 'x' })).rejects.toThrow(/not a secret this skill declared/);
    await setSecrets(owner.id, 'weather-lookup', { WEATHER_KEY: 'super-secret-value' });
    const view = publicSkill((await getSkill(owner.id, 'weather-lookup'))!);
    expect(JSON.stringify(view)).not.toContain('super-secret-value');
    expect(view.secretsSet).toEqual(['WEATHER_KEY']);

    const { proposals } = await runCalls(owner.id, [{ tool: 'enable_skill', input: { skillId: 'weather-lookup', acknowledgeUnverified: true }, reason: 'test' }]);
    expect(proposals[0].preview.description).toMatch(/without a verified checksum/);
    expect(getTool('skill.weather-lookup.forecast')).toBeUndefined();
    await approveProposal(owner.id, proposals[0].id);
    await drain();
    expect((await getSkill(owner.id, 'weather-lookup'))!.status).toBe('enabled');
    expect(getTool('skill.weather-lookup.forecast')).toBeDefined();
    unregisterSkillTools('weather-lookup');
  });

  it('runs a skill call only through approval, only to approved domains, with the secret injected server-side', async () => {
    process.env.SKILLS_ENABLED = 'true';
    process.env.SKILLS_ALLOW_PRIVATE_NETWORK = 'true';
    const seen: Array<{ url?: string; auth?: string }> = [];
    const server = http.createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ forecast: 'sunny', echoedKey: req.headers.authorization })); }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    const owner = await freshOwner();
    const m = manifest({ domains: ['localhost'], tools: [{ name: 'forecast', description: 'Get a forecast', method: 'GET', url: `http://localhost:${port}/forecast/{city}`, params: { city: { type: 'string', description: 'City', maxLength: 60 } }, headers: { Authorization: 'Bearer {{env.WEATHER_KEY}}' }, effect: 'read' }] });
    // The manifest schema requires https for declared tool URLs only at run time; allow the dev override for this loopback test.
    const parsed = { manifest: m as never, checksum: 'dev', verified: true };
    await installSkill(owner.id, parsed.manifest, parsed.checksum, true);
    await setSecrets(owner.id, 'weather-lookup', { WEATHER_KEY: 'abc123' });
    await enableSkill(owner.id, 'weather-lookup');
    try {
      const { proposals } = await runCalls(owner.id, [{ tool: 'skill.weather-lookup.forecast', input: { city: 'Paris/../admin' }, reason: 'asked' }]);
      expect(proposals[0].status).toBe('pending');
      expect(seen).toHaveLength(0);
      expect(proposals[0].preview.dataLeaving[0]).toMatch(/localhost/);
      await approveProposal(owner.id, proposals[0].id);
      await drain();
      expect(seen[0].url).toBe('/forecast/Paris%2F..%2Fadmin');
      expect(seen[0].auth).toBe('Bearer abc123');
      const execution = (await executionStore.list(owner.id))[0];
      expect(JSON.stringify(execution.output)).not.toContain('abc123');
      expect((await proposalStore.get(owner.id, proposals[0].id))!.status).toBe('executed');

      await setAllowedDomains(owner.id, 'weather-lookup', []);
      const blocked = await runCalls(owner.id, [{ tool: 'skill.weather-lookup.forecast', input: { city: 'Rome' }, reason: 'asked' }]);
      await approveProposal(owner.id, blocked.proposals[0].id);
      await drain();
      expect((await proposalStore.get(owner.id, blocked.proposals[0].id))!.lastError?.message).toMatch(/approved domain/);
      expect(seen).toHaveLength(1);
    } finally { unregisterSkillTools('weather-lookup'); server.close(); }
  });

  it('rejects undeclared parameters and disables / deletes cleanly', async () => {
    process.env.SKILLS_ENABLED = 'true';
    const owner = await freshOwner();
    const parsed = parseManifest(manifest());
    await installSkill(owner.id, parsed.manifest, parsed.checksum, true);
    await setSecrets(owner.id, 'weather-lookup', { WEATHER_KEY: 'k' });
    await enableSkill(owner.id, 'weather-lookup');
    const bad = await runCalls(owner.id, [{ tool: 'skill.weather-lookup.forecast', input: { city: 'Rome', extra: 'x' }, reason: 'x' }]);
    expect(bad.rejected).toHaveLength(1);
    await disableSkill(owner.id, 'weather-lookup');
    expect(getTool('skill.weather-lookup.forecast')).toBeUndefined();
    expect((await getSkill(owner.id, 'weather-lookup'))!.status).toBe('disabled');
    expect(await deleteSkill(owner.id, 'weather-lookup')).toBe(true);
    expect(await getSkill(owner.id, 'weather-lookup')).toBeNull();
  });

  it('re-registers enabled skills after a restart but not disabled ones', async () => {
    process.env.SKILLS_ENABLED = 'true';
    const owner = await freshOwner();
    const parsed = parseManifest(manifest());
    await installSkill(owner.id, parsed.manifest, parsed.checksum, true);
    await setSecrets(owner.id, 'weather-lookup', { WEATHER_KEY: 'k' });
    await enableSkill(owner.id, 'weather-lookup');
    unregisterSkillTools('weather-lookup');
    expect(getTool('skill.weather-lookup.forecast')).toBeUndefined();
    expect(await loadEnabledSkills()).toBe(1);
    expect(getTool('skill.weather-lookup.forecast')).toBeDefined();
    await disableSkill(owner.id, 'weather-lookup');
    expect(await loadEnabledSkills()).toBe(0);
  });
});

describe('MCP argument validation', () => {
  const schema = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['query'] };
  it('accepts valid arguments and rejects the rest', () => {
    expect(validateArguments(schema, { query: 'x', limit: 3, mode: 'a' })).toBeNull();
    expect(validateArguments(schema, {})).toMatch(/Missing/);
    expect(validateArguments(schema, { query: 3 })).toMatch(/string/);
    expect(validateArguments(schema, { query: 'x', extra: 1 })).toMatch(/Unexpected/);
    expect(validateArguments(schema, { query: 'x', mode: 'z' })).toMatch(/allowed/);
    expect(validateArguments(schema, [])).toMatch(/object/);
  });
});

void InMemoryTransport;

describe(`MCP wrapper (${storageMode})`, () => {
  it('discovers tools, defaults them to "always ask", and only runs approved calls', async () => {
    process.env.SKILLS_ENABLED = 'true';
    process.env.MCP_ENABLED = 'true';
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { discoverMcpTools, setMcpConnectorForTests, setMcpToolEffect } = await import('../server/agent/mcp.js');
    const calls: Array<Record<string, unknown>> = [];
    const makeServer = () => {
      const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: 'create_note', description: 'Create a note', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
        { name: 'list_notes', description: 'List notes', inputSchema: { type: 'object', properties: {} } }
      ] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => { calls.push(request.params.arguments ?? {}); return { content: [{ type: 'text', text: `ok:${request.params.name}` }] }; });
      return server;
    };
    setMcpConnectorForTests(async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await makeServer().connect(serverSide);
      const client = new Client({ name: 'orbit-test', version: '1' }, { capabilities: {} });
      await client.connect(clientSide);
      return client;
    });
    const owner = await freshOwner();
    const mcpManifest = { id: 'notes-server', name: 'Notes server', description: 'A remote notes MCP server.', version: '1.0.0', env: [], permissions: { read: ['Notes'], write: ['Notes'] }, domains: ['notes.example.com'], tools: [], mcp: { url: 'https://notes.example.com/mcp' } };
    const parsed = parseManifest(mcpManifest);
    try {
      await installSkill(owner.id, parsed.manifest, parsed.checksum, true);
      await expect(enableSkill(owner.id, 'notes-server')).rejects.toThrow(/Discover/);
      const tools = await discoverMcpTools(owner.id, 'notes-server');
      // The server claims create_note is read-only. Orbit ignores that hint.
      expect(tools.map((tool) => [tool.name, tool.effect])).toEqual([['create_note', 'write'], ['list_notes', 'write']]);
      const { mcpTools } = await import('../server/agent/mcp.js');
      await enableSkill(owner.id, 'notes-server', {}, (record) => mcpTools(record));
      expect(getTool('skill.notes-server.create_note')!.risk).toBe('skill_write');

      const write = await runCalls(owner.id, [{ tool: 'skill.notes-server.create_note', input: { text: 'hello' }, reason: 'asked' }]);
      expect(write.proposals[0].status).toBe('pending');
      expect(calls).toHaveLength(0);
      const invalid = await runCalls(owner.id, [{ tool: 'skill.notes-server.create_note', input: { wrong: 1 }, reason: 'asked' }]);
      expect(invalid.rejected).toHaveLength(1);
      await approveProposal(owner.id, write.proposals[0].id);
      await drain();
      expect(calls).toEqual([{ text: 'hello' }]);

      await setMcpToolEffect(owner.id, 'notes-server', 'list_notes', 'read');
      await enableSkill(owner.id, 'notes-server', {}, (record) => mcpTools(record));
      expect(getTool('skill.notes-server.list_notes')!.risk).toBe('skill_read');
    } finally { setMcpConnectorForTests(null); unregisterSkillTools('notes-server'); }
  });

  it('refuses MCP servers while MCP is disabled', async () => {
    process.env.SKILLS_ENABLED = 'true';
    const owner = await freshOwner();
    const parsed = parseManifest({ id: 'notes-server', name: 'Notes', description: 'x', version: '1.0.0', env: [], permissions: { read: [], write: [] }, domains: ['notes.example.com'], tools: [], mcp: { url: 'https://notes.example.com/mcp' } });
    await expect(installSkill(owner.id, parsed.manifest, parsed.checksum, true)).rejects.toThrow(/MCP servers are disabled/);
  });
});
