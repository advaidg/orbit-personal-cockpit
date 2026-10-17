/** Per-provider token buckets so a burst of sync or agent work cannot trip a provider's own rate limits. */
export interface BucketConfig {
  /** Maximum burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

const DEFAULTS: Record<string, BucketConfig> = {
  gmail: { capacity: 8, refillPerSecond: 8 },
  calendar: { capacity: 5, refillPerSecond: 5 },
  openai: { capacity: 3, refillPerSecond: 3 },
  chatgpt: { capacity: 2, refillPerSecond: 1 },
  anthropic: { capacity: 3, refillPerSecond: 3 },
  telegram: { capacity: 1, refillPerSecond: 1 },
  smtp: { capacity: 1, refillPerSecond: 0.5 },
  skill: { capacity: 2, refillPerSecond: 2 },
  mcp: { capacity: 2, refillPerSecond: 2 }
};
const FALLBACK: BucketConfig = { capacity: 2, refillPerSecond: 2 };

interface Bucket {
  tokens: number;
  updatedAt: number;
  blockedUntil: number;
  config: BucketConfig;
}

export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

export class ProviderLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: Clock = Date.now,
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  private bucket(provider: string): Bucket {
    let bucket = this.buckets.get(provider);
    if (!bucket) {
      const base = provider.split(':')[0];
      const config = DEFAULTS[provider] ?? DEFAULTS[base] ?? FALLBACK;
      bucket = { tokens: config.capacity, updatedAt: this.now(), blockedUntil: 0, config };
      this.buckets.set(provider, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket): void {
    const current = this.now();
    const elapsedSeconds = Math.max(0, (current - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(bucket.config.capacity, bucket.tokens + elapsedSeconds * bucket.config.refillPerSecond);
    bucket.updatedAt = current;
  }

  /** Milliseconds the caller would wait right now for `cost` tokens (0 when available). Does not consume. */
  waitTime(provider: string, cost = 1): number {
    const bucket = this.bucket(provider);
    this.refill(bucket);
    const blocked = Math.max(0, bucket.blockedUntil - this.now());
    const missing = Math.max(0, cost - bucket.tokens);
    return Math.max(blocked, Math.ceil((missing / bucket.config.refillPerSecond) * 1000));
  }

  /** Waits until `cost` tokens are available, then consumes them. */
  async acquire(provider: string, cost = 1): Promise<void> {
    for (;;) {
      const wait = this.waitTime(provider, cost);
      if (wait <= 0) {
        this.bucket(provider).tokens -= cost;
        return;
      }
      await this.sleep(wait);
    }
  }

  /** Called when a provider answered 429/Retry-After: pause that provider for `ms`. */
  penalize(provider: string, ms: number): void {
    const bucket = this.bucket(provider);
    bucket.blockedUntil = Math.max(bucket.blockedUntil, this.now() + ms);
    bucket.tokens = 0;
  }

  /** Runs `fn` after acquiring a token; a rate-limit style failure penalizes the provider. */
  async run<T>(provider: string, fn: () => Promise<T>, cost = 1): Promise<T> {
    await this.acquire(provider, cost);
    try {
      return await fn();
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      if (/rate limit|quota|429|too many requests/i.test(text)) this.penalize(provider, 10_000);
      throw error;
    }
  }
}

export const providerLimiter = new ProviderLimiter();
