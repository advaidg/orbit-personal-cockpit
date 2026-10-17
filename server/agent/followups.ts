import { getSettings, getSignal, getUser } from '../store.js';
import { composeDraft } from './compose.js';
import { commitments, getCommitment } from './commitments.js';
import { shareableMemories } from './memory.js';
import type { PlannedCall } from './proposals.js';

export const FOLLOW_UP_SNOOZE_DAYS = 3;

/** Builds the (unapproved) follow-up draft call for a commitment that has gone quiet. */
export async function followUpCall(userId: string, commitmentId: string): Promise<PlannedCall | null> {
  const commitment = await getCommitment(userId, commitmentId);
  if (!commitment?.evidenceSignalId) return null;
  const signal = await getSignal(userId, commitment.evidenceSignalId);
  if (!signal) return null;
  const [user, settings, preferences] = await Promise.all([getUser(userId), getSettings(userId), shareableMemories(userId)]);
  const draft = await composeDraft({ ownerName: user?.name ?? '', signal, kind: 'follow_up', waitingFor: commitment.action, preferences: preferences.filter((memory) => memory.type === 'communication_preference').map((memory) => memory.statement), settings, userId });
  return {
    tool: 'draft_reply',
    input: { signalId: signal.id, body: draft.body, kind: 'follow_up', round: (commitment.followUpCount ?? 0) + 1 },
    reason: `${commitment.otherPerson} has not replied about “${commitment.action}”.`,
    sourceSignalId: signal.id,
    generatedBy: draft.generatedBy
  };
}

/** Records that a follow-up was proposed so the same nudge is not repeated every day. */
export async function bumpFollowUp(userId: string, commitmentId: string, now = new Date()): Promise<void> {
  const commitment = await getCommitment(userId, commitmentId);
  if (!commitment) return;
  await commitments.update(userId, commitmentId, {
    followUpCount: (commitment.followUpCount ?? 0) + 1,
    lastFollowUpAt: now.toISOString(),
    followUpAt: new Date(now.getTime() + FOLLOW_UP_SNOOZE_DAYS * 86_400_000).toISOString(),
    updatedAt: now.toISOString()
  });
}

/** Owner pressed “Draft follow-up” on a commitment: build the draft proposal and note that a nudge was prepared. */
export async function proposeFollowUp(userId: string, commitmentId: string, now = new Date()) {
  const { ActionableError } = await import('../diagnostics.js');
  const call = await followUpCall(userId, commitmentId);
  if (!call) throw new ActionableError('Orbit cannot draft a follow-up for this one: it is not linked to an email.', { action: 'Open the original conversation in Gmail, or set a reminder instead.', code: 'no_evidence' });
  const commitment = (await getCommitment(userId, commitmentId))!;
  const [{ startRun }, { proposeCalls }] = await Promise.all([import('./runs.js'), import('./proposals.js')]);
  const run = await startRun(userId, { objective: `Follow up with ${commitment.otherPerson}`, trigger: { type: 'manual', ref: commitmentId, label: 'Draft follow-up' }, plan: [`Write a polite follow-up about “${commitment.action}”.`, 'Wait for your approval. Nothing is sent.'], provider: call.generatedBy ?? 'rules' }, now);
  const result = await proposeCalls(userId, run, [call]);
  if (result.proposals.length) await bumpFollowUp(userId, commitmentId, now);
  return { run, ...result };
}
