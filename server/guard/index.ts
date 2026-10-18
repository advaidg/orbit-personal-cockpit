import { registerGuardNotifications } from './telegram.js';

let initialized = false;

/** Wires Orbit Guard's notifications. Idempotent. */
export function initGuard(): void {
  if (initialized) return;
  registerGuardNotifications();
  initialized = true;
}
