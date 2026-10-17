import crypto from 'node:crypto';
import { Collection } from '../collection.js';
import type { Commitment } from './types.js';

export const commitments = new Collection<Commitment>('commitments');

export const DEFAULT_THEY_OWE_DAYS = 4;
export const DEFAULT_I_OWE_DAYS = 2;

export interface NewCommitment {
  direction: Commitment['direction'];
  otherPerson: string;
  otherEmail?: string;
  action: string;
  expectedAt?: string;
  evidenceSignalId?: string;
  evidence?: string;
  threadId?: string;
  confidence?: number;
}

/** Suggests when to expect the work (explicit date wins), defaulting to four days for "they owe". */
export function suggestExpectedAt(direction: Commitment['direction'], createdAt: Date, explicit?: string): string {
  if (explicit) return explicit;
  const days = direction === 'they_owe' ? DEFAULT_THEY_OWE_DAYS : DEFAULT_I_OWE_DAYS;
  return new Date(createdAt.getTime() + days * 86_400_000).toISOString();
}

export function commitmentKey(input: Pick<NewCommitment, 'direction' | 'evidenceSignalId' | 'otherEmail' | 'otherPerson' | 'action'>): string {
  const basis = input.evidenceSignalId ?? `${input.otherEmail ?? input.otherPerson}`.toLowerCase();
  const action = input.action.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
  return `${input.direction}:${basis}:${crypto.createHash('sha1').update(action).digest('hex').slice(0, 12)}`;
}

export async function createCommitment(userId: string, input: NewCommitment, now = new Date()): Promise<{ commitment: Commitment; created: boolean }> {
  const expectedAt = suggestExpectedAt(input.direction, now, input.expectedAt);
  const commitment: Commitment = {
    id: crypto.randomUUID(), userId, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    direction: input.direction, otherPerson: input.otherPerson.slice(0, 120), otherEmail: input.otherEmail?.toLowerCase(),
    action: input.action.slice(0, 240), status: 'open', expectedAt, followUpAt: expectedAt,
    evidenceSignalId: input.evidenceSignalId, evidence: input.evidence?.slice(0, 200), threadId: input.threadId,
    confidence: input.confidence ?? 0.6
  };
  const result = await commitments.insert(commitment, commitmentKey(input));
  return { commitment: result.item, created: result.created };
}

export async function listCommitments(userId: string, options: { status?: Commitment['status'][]; direction?: Commitment['direction'] } = {}): Promise<Commitment[]> {
  const where: Record<string, string[] | string> = {};
  if (options.status) where.status = options.status;
  if (options.direction) where.direction = options.direction;
  const rows = await commitments.list(userId, { where });
  return rows.sort((a, b) => (a.expectedAt ?? '9').localeCompare(b.expectedAt ?? '9'));
}

export async function resolveCommitment(userId: string, id: string, resolutionSignalId?: string): Promise<Commitment | null> {
  return commitments.transition(userId, id, ['open', 'snoozed'], { status: 'resolved', resolvedAt: new Date().toISOString(), resolutionSignalId, updatedAt: new Date().toISOString() });
}

export async function snoozeCommitment(userId: string, id: string, until: string): Promise<Commitment | null> {
  return commitments.transition(userId, id, ['open', 'snoozed'], { status: 'snoozed', followUpAt: until, updatedAt: new Date().toISOString() });
}

export async function reopenCommitment(userId: string, id: string): Promise<Commitment | null> {
  return commitments.transition(userId, id, ['resolved', 'snoozed', 'dismissed'], { status: 'open', resolvedAt: undefined, resolutionSignalId: undefined, updatedAt: new Date().toISOString() });
}

export async function dismissCommitment(userId: string, id: string): Promise<Commitment | null> {
  return commitments.transition(userId, id, ['open', 'snoozed'], { status: 'dismissed', updatedAt: new Date().toISOString() });
}

export const getCommitment = (userId: string, id: string) => commitments.get(userId, id);
export const deleteCommitment = (userId: string, id: string) => commitments.delete(userId, id);

/** Open or snoozed commitments whose follow-up time has passed. */
export async function dueCommitments(userId: string, now = new Date()): Promise<Commitment[]> {
  return (await listCommitments(userId, { status: ['open', 'snoozed'] })).filter((item) => (item.followUpAt ?? item.expectedAt ?? '9') <= now.toISOString());
}
