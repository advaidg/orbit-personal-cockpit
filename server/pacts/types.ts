import type { Owned } from '../collection.js';

export type PactDirection = 'i_owe' | 'they_owe';
export type PactStatus = 'open' | 'done' | 'declined' | 'canceled';
/** Who did something to a pact. The owner is the person who runs this installation. */
export type PactActor = 'owner' | 'counterparty' | 'peer';
export type PactAction = 'confirm' | 'done' | 'reschedule' | 'decline' | 'cancel';
export type PactRole = 'doer' | 'requester';

export interface PactEvent {
  at: string;
  actor: PactActor;
  action: PactAction | 'created' | 'link_rotated' | 'link_revoked';
  note?: string;
  date?: string;
}

/**
 * A promise between the owner and one other person. `direction` is always from the owner's point of view:
 * `i_owe` means the owner is the doer, `they_owe` means the other person is.
 */
export interface Pact extends Owned {
  direction: PactDirection;
  otherPerson: string;
  otherEmail?: string;
  action: string;
  status: PactStatus;
  /** True once the other side said "I'm on it" (or "that is right"). */
  confirmed: boolean;
  dueAt?: string;
  /** A date the requester asked for; never applied automatically. */
  requestedDueAt?: string;
  commitmentId?: string;
  channel: 'link' | 'federated';
  /** SHA-256 of the link secret. The secret itself is never stored. */
  linkHash?: string;
  linkExpiresAt?: string;
  linkRevokedAt?: string;
  /** Federated mirror: which trusted peer holds the other copy, and its id for this pact. */
  peerId?: string;
  remotePactId?: string;
  events: PactEvent[];
  /** Optimistic-concurrency counter; every state change is a compare-and-set on it. */
  rev: number;
  updatedAt: string;
}

/** What a person on the other end of a link is allowed to see. Never includes email or owner internals. */
export interface PublicPact {
  /** The owner's timezone, so dates on the page match the day they meant. */
  timeZone: string;
  ownerName: string;
  otherPerson: string;
  action: string;
  dueAt?: string;
  status: PactStatus;
  confirmed: boolean;
  role: PactRole;
  requestedDueAt?: string;
  expiresAt?: string;
}
