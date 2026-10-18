/**
 * The small program Claude Code runs before every tool call. It has no dependencies (Node 18+), forwards the call to
 * Orbit, prints Orbit's answer, and does one thing more: it reports the session's token use, read from Claude Code's
 * own transcript on your machine, so Orbit can enforce a daily budget. Nothing from the transcript except token counts
 * is ever sent.
 *
 * It is served from Orbit itself (GET /guard/hook.mjs) so installing is one download. It avoids template literals so
 * it can live inside this string.
 */
export const HOOK_SCRIPT = String.raw`#!/usr/bin/env node
// Orbit Guard hook for Claude Code (PreToolUse). https://github.com/advaidg/orbit-personal-cockpit
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = (process.env.ORBIT_URL || '').replace(/\/+$/, '');
const token = process.env.ORBIT_GUARD_TOKEN || '';
const failMode = process.env.ORBIT_GUARD_FAIL === 'deny' ? 'deny' : 'defer';
const timeoutMs = (Number(process.env.ORBIT_GUARD_TIMEOUT) || 600) * 1000;

function giveBack(message) {
  // Orbit could not be reached: hand control back to Claude Code's own prompt (or refuse, if you asked for that).
  if (message) process.stderr.write('orbit-guard: ' + message + '\n');
  if (failMode === 'deny') { process.stderr.write('orbit-guard: refusing because ORBIT_GUARD_FAIL=deny\n'); process.exit(2); }
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Sums token use from the transcript, reading only what was added since the last call. Best effort: any problem means "no usage". */
function usageFor(event) {
  try {
    const file = event.transcript_path;
    if (!file || !event.session_id) return undefined;
    const cacheFile = path.join(os.tmpdir(), 'orbit-guard-' + String(event.session_id).replace(/[^A-Za-z0-9_-]/g, '') + '.json');
    let state = { offset: 0, byId: {} };
    try { state = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first call in this session */ }
    const size = fs.statSync(file).size;
    if (size < state.offset) state = { offset: 0, byId: {} };
    if (size - state.offset > 64 * 1024 * 1024) return undefined;
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size - state.offset);
    fs.readSync(fd, buffer, 0, buffer.length, state.offset);
    fs.closeSync(fd);
    const text = buffer.toString('utf8');
    const complete = text.lastIndexOf('\n') + 1;
    for (const line of text.slice(0, complete).split('\n')) {
      if (!line.includes('"usage"')) continue;
      try {
        const entry = JSON.parse(line);
        const message = entry.message || {};
        const usage = message.usage;
        if (usage && typeof usage === 'object') {
          state.byId[message.id || entry.uuid || String(Object.keys(state.byId).length)] = [usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0];
        }
      } catch { /* skip a line we cannot read */ }
    }
    state.offset += Buffer.byteLength(text.slice(0, complete));
    fs.writeFileSync(cacheFile, JSON.stringify(state), { mode: 0o600 });
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const [input, output, read, write] of Object.values(state.byId)) { totals.input += input; totals.output += output; totals.cacheRead += read; totals.cacheWrite += write; }
    return { session_id: String(event.session_id), totals };
  } catch { return undefined; }
}

if (!url || !token) giveBack('ORBIT_URL and ORBIT_GUARD_TOKEN are not set, so Claude Code is asking you itself.');

let event;
try { event = JSON.parse(await readStdin()); } catch { giveBack('could not read the hook input.'); }

try {
  const response = await fetch(url + '/guard/v1/hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ ...event, orbit_usage: usageFor(event) }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) giveBack('Orbit answered ' + response.status + (response.status === 401 ? ' (check ORBIT_GUARD_TOKEN)' : '') + '.');
  const body = await response.text();
  if (body && body !== '{}') process.stdout.write(body);
  process.exit(0);
} catch (error) {
  giveBack('could not reach Orbit (' + (error && error.name === 'TimeoutError' ? 'timed out' : 'network error') + ').');
}
`;
