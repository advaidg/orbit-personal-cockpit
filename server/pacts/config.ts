type Env = Record<string, string | undefined>;

export interface PactLimits {
  enabled: boolean;
  federationEnabled: boolean;
  telegramInbound: boolean;
  linkTtlDays: number;
  maxOpenPacts: number;
  repoUrl: string;
}

const flag = (value: string | undefined, fallback: boolean) => (value === undefined || value === '' ? fallback : ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase()));

export function pactLimits(env: Env = process.env): PactLimits {
  const ttl = Number(env.PACT_LINK_TTL_DAYS);
  const cap = Number(env.PACT_MAX_OPEN);
  return {
    enabled: flag(env.PACTS_ENABLED, true),
    // Federation exposes public endpoints, so it is opt-in.
    federationEnabled: flag(env.FEDERATION_ENABLED, false),
    telegramInbound: flag(env.TELEGRAM_INBOUND_ENABLED, true),
    linkTtlDays: Number.isFinite(ttl) && ttl > 0 ? Math.min(365, Math.floor(ttl)) : 45,
    maxOpenPacts: Number.isFinite(cap) && cap > 0 ? Math.min(5000, Math.floor(cap)) : 500,
    repoUrl: env.ORBIT_REPO_URL || 'https://github.com/advaidg/orbit-personal-cockpit'
  };
}

/** Public base URL of this installation, used in pact links and as the federation identity. */
export function publicBaseUrl(env: Env = process.env): string {
  const raw = env.APP_URL || `http://localhost:${env.PORT || 3000}`;
  return new URL(raw).origin;
}
