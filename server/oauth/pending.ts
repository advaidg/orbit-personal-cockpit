/**
 * Short-lived state for sign-in flows that start in one request and finish in another (PKCE verifiers, state
 * values). It lives in memory on purpose: a restart mid-flow just means "start again", and nothing secret is
 * ever written to storage.
 */
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 50;

export class PendingFlows<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  /** Stores a value under `key`, replacing any earlier attempt. */
  put(key: string, value: T, now = Date.now()): void {
    this.sweep(now);
    if (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(key, { value, expiresAt: now + TTL_MS });
  }

  /** Returns the value without removing it. */
  peek(key: string, now = Date.now()): T | undefined {
    const hit = this.entries.get(key);
    if (!hit || hit.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /** Returns the value and forgets it, so a flow can only be finished once. */
  take(key: string, now = Date.now()): T | undefined {
    const value = this.peek(key, now);
    this.entries.delete(key);
    return value;
  }

  clear(): void {
    this.entries.clear();
  }

  private sweep(now: number): void {
    for (const [key, hit] of this.entries) if (hit.expiresAt <= now) this.entries.delete(key);
  }
}
