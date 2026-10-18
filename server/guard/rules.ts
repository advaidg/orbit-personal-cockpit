import { ActionableError } from '../diagnostics.js';
import { splitCommand } from './shell.js';
import { sha256 } from './summary.js';
import type { GuardRule } from './types.js';

const MAX_GLOB = 300;
const MAX_SUBJECT = 20_000;

/**
 * Glob matching where only * and ? mean anything, done with a linear scan instead of a regular expression, so a
 * pattern full of wildcards can never make the matcher run away (no catastrophic backtracking).
 */
export function globMatch(pattern: string, text: string): boolean {
  const p = pattern.slice(0, MAX_GLOB);
  const t = text.slice(0, MAX_SUBJECT);
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) { pi += 1; ti += 1; }
    else if (pi < p.length && p[pi] === '*') { star = pi; mark = ti; pi += 1; }
    else if (star !== -1) { pi = star + 1; mark += 1; ti = mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === '*') pi += 1;
  return pi === p.length;
}

export const underProject = (cwd: string | undefined, project: string | undefined): boolean => {
  if (!project) return true;
  if (!cwd) return false;
  const base = project.replace(/\/+$/, '');
  return cwd === base || cwd.startsWith(`${base}/`);
};

export interface RuleCall { tool: string; subject: string; cwd?: string }

function matches(rule: GuardRule, call: RuleCall): boolean {
  if (rule.tool !== '*' && rule.tool !== call.tool) return false;
  if (!underProject(call.cwd, rule.project)) return false;
  if (rule.match === 'exact') return !!rule.valueHash && rule.valueHash === sha256(call.subject);
  if (!globMatch(rule.value, call.subject)) return false;
  // An allow rule must never cover a chain: `git push*` would otherwise also approve `git push && rm -rf x`.
  if (rule.action === 'allow' && (call.tool === 'Bash' || call.tool === 'BashTool') && splitCommand(call.subject).length !== 1) return false;
  return true;
}

/** deny beats ask beats allow among the rules that match. Returns the winning rule, if any. */
export function matchRule(rules: GuardRule[], call: RuleCall): GuardRule | null {
  const hits = rules.filter((rule) => matches(rule, call));
  return hits.find((rule) => rule.action === 'deny') ?? hits.find((rule) => rule.action === 'ask') ?? hits.find((rule) => rule.action === 'allow') ?? null;
}

/** Rejects rules that would quietly switch the guard off. */
export function validateRuleInput(input: { tool: string; match: GuardRule['match']; value: string; action: GuardRule['action'] }): void {
  const value = input.value.trim();
  if (!value) throw new ActionableError('A rule needs something to match.', { action: 'Enter a command or path.', code: 'invalid_request' });
  if (input.match === 'glob' && input.action === 'allow') {
    const literal = value.replace(/[*?]/g, '');
    if (input.tool === '*') throw new ActionableError('An allow rule has to name a tool.', { action: 'Choose Bash, Edit or another tool.', code: 'rule_too_broad' });
    if (literal.length < 3 || /^[*?\s]/.test(value)) throw new ActionableError('That pattern is too broad to allow safely.', { action: 'Start with the program name, for example “npm run build*”.', code: 'rule_too_broad' });
  }
}
