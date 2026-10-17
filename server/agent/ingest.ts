import { logSafe } from '../diagnostics.js';
import { getSettings, getUser } from '../store.js';
import type { FetchedMessage } from '../gmail.js';
import type { Connection, Signal } from '../types.js';
import { agentLimits } from './config.js';
import { composeDraft } from './compose.js';
import { listCommitments } from './commitments.js';
import { detectCommitments, detectDeadline, detectResolution, NO_REPLY } from './detect.js';
import { shareableMemories } from './memory.js';
import { proposeCalls, type PlannedCall } from './proposals.js';
import { startRun } from './runs.js';
import { getAgentSettings } from './settings.js';
import { displayName, extractEmail } from './tools/util.js';
import type { Commitment } from './types.js';
import { runSignalAutomations } from './automations.js';

export interface IngestItem {
  signal: Signal;
  message: FetchedMessage;
}

const WEIGHT: Record<string, number> = { resolve_commitment: 0, mark_waiting_on: 1, draft_reply: 2, extract_deadline: 3 };
const PRIORITY_WEIGHT = { now: 0, soon: 1, later: 2 } as const;
const DRAFTABLE = new Set<Signal['category']>(['action', 'waiting', 'people']);

function isReplyable(item: IngestItem): boolean {
  const address = item.signal.metadata?.fromAddress;
  return item.signal.metadata?.direction !== 'outbound' && typeof address === 'string' && !NO_REPLY.test(address) && !NO_REPLY.test(item.message.from);
}

/** Bounds how much text an excerpt can carry into an explanation shown to the owner. */
const quote = (text: string) => `“${text.replace(/\s+/g, ' ').slice(0, 160)}”`;

/** Finds open commitments that this message plausibly completes. */
function closures(item: IngestItem, open: Commitment[]): PlannedCall[] {
  const threadId = item.signal.metadata?.threadId;
  if (typeof threadId !== 'string') return [];
  const inbound = item.signal.metadata?.direction !== 'outbound';
  const hint = detectResolution(item.message.rawText);
  return open
    .filter((commitment) => commitment.threadId === threadId && commitment.evidenceSignalId !== item.signal.id && commitment.createdAt < item.signal.occurredAt)
    .filter((commitment) => (commitment.direction === 'they_owe' && inbound) || (commitment.direction === 'i_owe' && !inbound))
    .map((commitment) => ({
      tool: 'resolve_commitment',
      input: { commitmentId: commitment.id, resolutionSignalId: item.signal.id, evidence: hint.excerpt },
      reason: hint.strong ? `${commitment.direction === 'they_owe' ? displayName(commitment.otherPerson) : 'You'} replied in the same thread with what looks like completion: ${quote(hint.excerpt ?? '')}` : `There was a later message in the same thread. It may not be complete, so Orbit is asking before closing it.`,
      sourceSignalId: item.signal.id
    }));
}

/** Converts newly synced messages into proposals (never actions) and runs matching automations. */
export async function ingestNewMessages(userId: string, connection: Connection, items: IngestItem[]): Promise<void> {
  const limits = agentLimits();
  if (!limits.enabled || !items.length) return;
  const agentSettings = await getAgentSettings(userId);
  if (agentSettings.paused) return;
  const [settings, user, open, preferences] = await Promise.all([getSettings(userId), getUser(userId), listCommitments(userId, { status: ['open', 'snoozed'] }), shareableMemories(userId)]);
  const now = new Date();
  const calls: Array<PlannedCall & { weight: number; priority: number }> = [];
  const push = (call: PlannedCall, priority: Signal['priority']) => calls.push({ ...call, weight: WEIGHT[call.tool] ?? 9, priority: PRIORITY_WEIGHT[priority] });
  const draftsEnabled = agentSettings.gmailAccess === 'drafts';
  const accountEmail = connection.accountEmail?.toLowerCase();

  for (const item of items) {
    const { signal, message } = item;
    const outbound = signal.metadata?.direction === 'outbound';
    if (!outbound && signal.category === 'noise') continue;
    const otherEmail = extractEmail(outbound ? message.to : message.replyTo || message.from);
    if (otherEmail && otherEmail === accountEmail) continue;
    const otherPerson = displayName(outbound ? message.to : message.from);

    const candidates = detectCommitments(message.rawText, { messageDirection: outbound ? 'outbound' : 'inbound', otherPerson, otherEmail, now, timeZone: agentSettings.timezone });
    for (const candidate of candidates) {
      push({
        tool: 'mark_waiting_on',
        input: { signalId: signal.id, direction: candidate.direction, otherPerson: candidate.otherPerson, otherEmail: candidate.otherEmail, action: candidate.action, expectedAt: candidate.expectedAt, evidence: candidate.evidence, threadId: message.threadId, confidence: candidate.confidence },
        reason: candidate.direction === 'they_owe' ? `${candidate.otherPerson} wrote ${quote(candidate.evidence)}` : `You were asked or promised: ${quote(candidate.evidence)}`,
        sourceSignalId: signal.id
      }, signal.priority);
    }

    const deadline = outbound ? null : detectDeadline(message.rawText, now, agentSettings.timezone, candidates.map((candidate) => candidate.evidence));
    if (deadline && signal.priority !== 'later') {
      push({ tool: 'extract_deadline', input: { signalId: signal.id, dueAt: deadline.dueAt, label: signal.title }, reason: `The message mentions a date: ${quote(deadline.excerpt)}`, sourceSignalId: signal.id }, signal.priority);
    }

    for (const call of closures(item, open)) push(call, signal.priority);

    if (draftsEnabled && DRAFTABLE.has(signal.category) && signal.priority !== 'later' && isReplyable(item)) {
      const draft = await composeDraft({ ownerName: user?.name ?? '', signal, kind: 'reply', preferences: preferences.filter((memory) => memory.type === 'communication_preference').map((memory) => memory.statement), settings, userId });
      push({ tool: 'draft_reply', input: { signalId: signal.id, body: draft.body, kind: 'reply', round: 1 }, reason: `“${signal.title}” looks like it needs a reply.`, sourceSignalId: signal.id, generatedBy: draft.generatedBy }, signal.priority);
    }
  }

  const planned = calls.sort((a, b) => a.priority - b.priority || a.weight - b.weight).slice(0, limits.maxSteps).map(({ weight: _weight, priority: _priority, ...call }) => call);
  if (planned.length) {
    const run = await startRun(userId, {
      objective: `Review ${items.length} new message${items.length === 1 ? '' : 's'} from ${connection.label}`,
      trigger: { type: 'sync', ref: connection.id, label: connection.label },
      plan: ['Look for promises, requests, deadlines and replies that close open loops.', draftsEnabled ? 'Prepare reply drafts for messages that need one.' : 'Gmail drafts are off, so no reply drafts are prepared.', 'Propose each change for your approval; nothing is sent.'],
      provider: settings.aiProvider
    });
    await proposeCalls(userId, run, planned);
  }
  await runSignalAutomations(userId, items.map((item) => item.signal)).catch((error) => logSafe('automations', error));
}
