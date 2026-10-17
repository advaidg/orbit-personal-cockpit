import { registerFederationJobs } from '../federation/outbox.js';
import { registerPactTools } from '../agent/tools/pacts.js';

let initialized = false;

/** Registers pact tools and the durable federation sender. Idempotent. */
export function initPacts(): void {
  if (initialized) return;
  registerPactTools();
  registerFederationJobs();
  initialized = true;
}
