import crypto from 'node:crypto';
import { createNotification } from '../notify.js';
import { logSafe } from '../diagnostics.js';
import { classify, rate } from './classify.js';
import { matchRule } from './rules.js';
import { addRule, events, getSettings, listRules, requests, rulesStore, updateAgent } from './store.js';
import { projectLabel, sha256, subjectOf, summarize } from './summary.js';
import { costOf, recordUsage, sanitizeTotals, usageToday, markBudgetNotified, weighted } from './usage.js';
import type { Classification, DecidedBy, GuardAgent, GuardRequest, HookEvent, UsageTotals, Verdict } from './types.js';

/** What Claude Code's PreToolUse hook expects back. An empty object means "no opinion". */
export type HookBody = Record<string, never> | { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'allow' | 'deny' | 'ask'; permissionDecisionReason: string } };

export const MAX_PENDING_PER_AGENT = 10;
const MAX_WAIT_SECONDS = 540;
const pollMs = () => Number(process.env.GUARD_POLL_MS) || 600;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Called when a request needs a human. Set by the Telegram module so the engine stays free of chat code. */
export const guardHooks: { onRequest?: (request: GuardRequest) => Promise<void>; onResolved?: (request: GuardRequest) => Promise<void> } = {};

const respond = (decision: 'allow' | 'deny' | 'ask', reason: string): HookBody => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason.slice(0, 400) } });

export interface HookResult {
  body: HookBody;
  verdict: Verdict;
  decidedBy: DecidedBy;
}

export interface DecideInput {
  agent: GuardAgent;
  event: HookEvent;
  usage?: { sessionId?: string; totals?: unknown };
  now?: Date;
}

async function recordEvent(agent: GuardAgent, event: HookEvent, classification: Classification, verdict: Verdict, decidedBy: DecidedBy, waitedMs: number, extra: { requestId?: string; ruleId?: string } = {}): Promise<void> {
  await events.insert({
    id: crypto.randomUUID(), userId: agent.userId, createdAt: new Date().toISOString(), agentId: agent.id, agentName: agent.name, sessionId: event.session_id?.slice(0, 80),
    tool: (event.tool_name ?? 'unknown').slice(0, 80), summary: summarize(event), project: projectLabel(event.cwd), category: classification.category, reasons: classification.reasons, verdict, decidedBy, waitedMs, ...extra
  });
}

/** Counts this session's reported tokens and enforces the agent's daily budget. Returns a reason when over budget. */
async function enforceBudget(agent: GuardAgent, input: DecideInput): Promise<string | null> {
  const totals = sanitizeTotals(input.usage?.totals) as UsageTotals | null;
  let day = await usageToday(agent.userId, agent.id, input.now);
  if (totals && input.usage?.sessionId) day = await recordUsage(agent.userId, agent.id, input.usage.sessionId.slice(0, 80), totals, input.now);
  if (!agent.dailyTokenBudget || weighted(day.totals) < agent.dailyTokenBudget) return null;
  if (await markBudgetNotified(agent.userId, day.id)) {
    const cost = await costOf(agent.userId, day.totals);
    await createNotification(agent.userId, { title: `${agent.name} reached its daily budget`, body: `${weighted(day.totals).toLocaleString('en-US')} weighted tokens used${cost !== null ? ` (about $${cost.toFixed(2)})` : ''}. New tool calls are blocked until tomorrow, or until you raise the limit.`, kind: 'alert', link: '/#/guard' }).catch((error) => logSafe('guard budget notice', error));
  }
  return `Orbit stopped this agent: it reached today's token budget (${agent.dailyTokenBudget.toLocaleString('en-US')}). Raise or remove the limit in Orbit → Agents.`;
}

function reasonText(classification: Classification, fallback: string): string {
  return classification.reasons.length ? classification.reasons.join('; ') : fallback;
}

/**
 * Decides one tool call. Safe calls are allowed at once, catastrophic ones refused, unknown ones handed back to the
 * agent's own prompt, and risky ones held until the owner answers on their phone.
 */
export async function decide(input: DecideInput): Promise<HookResult> {
  const { agent, event } = input;
  const started = Date.now();
  const settings = await getSettings(agent.userId);
  const tool = (event.tool_name ?? '').slice(0, 80);
  const toolInput = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  const cwd = typeof event.cwd === 'string' ? event.cwd.slice(0, 500) : undefined;
  await updateAgent(agent.userId, agent.id, { lastSeenAt: new Date().toISOString() });

  const finish = async (classification: Classification, verdict: Verdict, decidedBy: DecidedBy, body: HookBody, extra: { requestId?: string; ruleId?: string } = {}): Promise<HookResult> => {
    await recordEvent(agent, event, classification, verdict, decidedBy, Date.now() - started, extra).catch((error) => logSafe('guard event', error));
    return { body, verdict, decidedBy };
  };

  const overBudget = await enforceBudget(agent, input).catch((error) => (logSafe('guard budget', error), null));
  const call = { tool, input: toolInput, cwd };
  const rated = rate(call);
  const base = classify(call, settings.strictness);

  if (agent.paused) return finish(base, 'deny', 'policy', respond('deny', 'Orbit paused this agent. Resume it in Orbit → Agents.'));
  if (overBudget) return finish(base, 'deny', 'budget', respond('deny', overBudget));
  if (!tool) return finish({ verdict: 'defer', reasons: [], category: 'unknown' }, 'defer', 'policy', {});

  // The catastrophic list cannot be overridden by any rule.
  if (rated.severity === 'deny') return finish(base, 'deny', 'policy', respond('deny', `Orbit blocked this: ${reasonText(base, 'it could destroy data')}.`));

  const subject = subjectOf(tool, toolInput, cwd);
  const rule = matchRule(await listRules(agent.userId), { tool, subject, cwd });
  let classification = base;
  let decidedBy: DecidedBy = 'policy';
  if (rule) {
    classification = { ...base, verdict: rule.action, reasons: rule.note ? [rule.note, ...base.reasons].slice(0, 4) : base.reasons };
    decidedBy = 'rule';
    await rulesStore.update(agent.userId, rule.id, { hits: rule.hits + 1, lastHitAt: new Date().toISOString() }).catch(() => undefined);
  }

  if (classification.verdict === 'allow') return finish(classification, 'allow', decidedBy, respond('allow', rule ? 'Allowed by your Orbit rule.' : 'Orbit judged this safe.'), { ruleId: rule?.id });
  if (classification.verdict === 'deny') return finish(classification, 'deny', decidedBy, respond('deny', `Blocked by your Orbit rule${rule?.note ? `: ${rule.note}` : '.'}`), { ruleId: rule?.id });
  if (classification.verdict === 'defer') return finish(classification, 'defer', decidedBy, {});

  // ask: hold the agent until the owner answers on their phone.
  const result = await askOwner(agent, event, classification, subject, cwd, settings.waitSeconds, settings.onTimeout);
  await recordEvent(agent, event, classification, result.verdict, result.decidedBy, Date.now() - started, { requestId: result.requestId, ruleId: rule?.id }).catch((error) => logSafe('guard event', error));
  return { body: result.body, verdict: result.verdict, decidedBy: result.decidedBy };
}

interface AskResult { body: HookBody; verdict: Verdict; decidedBy: DecidedBy; requestId?: string }

async function askOwner(agent: GuardAgent, event: HookEvent, classification: Classification, subject: string, cwd: string | undefined, waitSeconds: number, onTimeout: 'defer' | 'deny'): Promise<AskResult> {
  const pending = await requests.count(agent.userId, { agentId: agent.id, status: 'pending' });
  if (pending >= MAX_PENDING_PER_AGENT) return { body: {}, verdict: 'defer', decidedBy: 'policy' }; // never flood the owner's phone

  const wait = Math.min(MAX_WAIT_SECONDS, Math.max(Number(process.env.GUARD_MIN_WAIT_SECONDS) || 5, waitSeconds));
  const now = new Date();
  const toolUseId = event.tool_use_id?.slice(0, 80);
  const candidate: GuardRequest = {
    id: crypto.randomUUID(), userId: agent.userId, createdAt: now.toISOString(), updatedAt: now.toISOString(), agentId: agent.id, agentName: agent.name,
    sessionId: event.session_id?.slice(0, 80), tool: (event.tool_name ?? '').slice(0, 80), summary: summarize(event), project: projectLabel(cwd), cwd, subjectHash: sha256(subject),
    reasons: classification.reasons, category: classification.category, status: 'pending', expiresAt: new Date(now.getTime() + wait * 1000).toISOString()
  };
  // A retried hook call for the same tool use joins the same question instead of asking twice.
  const { item: request, created } = await requests.insert(candidate, toolUseId ? `use:${agent.id}:${toolUseId}` : undefined);
  if (created) await guardHooks.onRequest?.(request).catch((error) => logSafe('guard notify', error));

  const deadline = new Date(request.expiresAt).getTime();
  for (;;) {
    const current = (await requests.get(agent.userId, request.id)) ?? request;
    if (current.status === 'approved') return { body: respond('allow', current.remembered ? 'Approved on your phone, and remembered for this project.' : 'Approved on your phone.'), verdict: 'allow', decidedBy: 'owner', requestId: current.id };
    if (current.status === 'denied') return { body: respond('deny', 'You declined this in Orbit.'), verdict: 'deny', decidedBy: 'owner', requestId: current.id };
    if (current.status === 'expired' || Date.now() >= deadline) {
      const expired = await requests.transition(agent.userId, request.id, ['pending'], { status: 'expired', decidedBy: 'timeout', decidedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (expired) await guardHooks.onResolved?.(expired).catch(() => undefined);
      const fresh = (await requests.get(agent.userId, request.id)) ?? request;
      if (fresh.status === 'approved') return { body: respond('allow', 'Approved on your phone.'), verdict: 'allow', decidedBy: 'owner', requestId: fresh.id };
      if (fresh.status === 'denied') return { body: respond('deny', 'You declined this in Orbit.'), verdict: 'deny', decidedBy: 'owner', requestId: fresh.id };
      return onTimeout === 'deny' ? { body: respond('deny', 'Nobody answered in time, so Orbit refused it.'), verdict: 'deny', decidedBy: 'timeout', requestId: request.id } : { body: {}, verdict: 'defer', decidedBy: 'timeout', requestId: request.id };
    }
    await sleep(Math.min(pollMs(), Math.max(10, deadline - Date.now())));
  }
}

/** The owner's answer. Atomic: two taps cannot both decide, and a request that already expired stays expired. */
export async function resolveRequest(userId: string, id: string, decision: 'approved' | 'denied', options: { remember?: boolean } = {}): Promise<GuardRequest | null> {
  const current = await requests.get(userId, id);
  if (!current) return null;
  const remember = !!options.remember && decision === 'approved' && !!current.subjectHash && (current.tool === 'Bash' || current.cwd !== undefined);
  const next = await requests.transition(userId, id, ['pending'], { status: decision, decidedBy: 'owner', decidedAt: new Date().toISOString(), remembered: remember || undefined, updatedAt: new Date().toISOString() });
  if (!next) return null;
  // Remember this exact call, in this project only. The command is matched by its hash and shown by its redacted summary.
  if (remember && current.cwd && current.subjectHash) await addRule(userId, { tool: current.tool, match: 'exact', value: current.summary, valueHash: current.subjectHash, project: current.cwd, action: 'allow', note: 'Approved on your phone' });
  await guardHooks.onResolved?.(next).catch(() => undefined);
  return next;
}

