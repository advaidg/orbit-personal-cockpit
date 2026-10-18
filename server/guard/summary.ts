import crypto from 'node:crypto';
import { basename } from './posix.js';
import { redact } from '../diagnostics.js';
import { resolvePath } from './paths.js';
import type { HookEvent } from './types.js';

export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The text a rule is matched against: the command, the absolute path, or the tool name. */
export function subjectOf(tool: string, input: Record<string, unknown>, cwd: string | undefined): string {
  if (tool === 'Bash' || tool === 'BashTool') return str(input.command).trim();
  const file = str(input.file_path) || str(input.path) || str(input.notebook_path);
  if (file) return resolvePath(file, cwd);
  if (tool === 'WebFetch') return urlLabel(str(input.url));
  return tool;
}

function urlLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return redact(raw, 120);
  }
}

/**
 * What the owner sees for a call. It is a rendering, never a copy: secrets are redacted, query strings and file
 * contents are left out, and the length is capped. It is always shown as plain text.
 */
export function summarize(event: HookEvent): string {
  const tool = event.tool_name ?? 'unknown tool';
  const input = event.tool_input ?? {};
  if (tool === 'Bash' || tool === 'BashTool') return redact(str(input.command) || '(empty command)', 400);
  const file = str(input.file_path) || str(input.path) || str(input.notebook_path);
  if (file) {
    const size = typeof input.content === 'string' ? ` (${input.content.length.toLocaleString('en-US')} characters)` : '';
    return `${tool} ${redact(file, 200)}${size}`;
  }
  if (tool === 'WebFetch') return `WebFetch ${urlLabel(str(input.url))}`;
  if (tool === 'WebSearch') return `WebSearch “${redact(str(input.query), 120)}”`;
  const keys = Object.keys(input).slice(0, 6).join(', ');
  return `${tool}${keys ? ` (${keys})` : ''}`;
}

export const projectLabel = (cwd: string | undefined): string | undefined => (cwd ? basename(cwd) || undefined : undefined);
