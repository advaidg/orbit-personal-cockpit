type Env = Record<string, string | undefined>;

/**
 * Works out the public address from the host's own variables, so installers on Railway do not have to type it.
 * An explicit APP_URL always wins. Returns undefined when nothing can be inferred.
 */
export function deriveAppUrl(env: Env = process.env): string | undefined {
  if (env.APP_URL) return env.APP_URL;
  const domain = env.RAILWAY_PUBLIC_DOMAIN || env.RAILWAY_STATIC_URL?.replace(/^https?:\/\//, '');
  if (domain && /^[A-Za-z0-9.-]+$/.test(domain)) return `https://${domain}`;
  return undefined;
}

/** Fills APP_URL from the host when it was left blank. Call once, before anything reads it. */
export function applyDerivedAppUrl(env: Env = process.env): void {
  const derived = deriveAppUrl(env);
  if (derived && !env.APP_URL) env.APP_URL = derived;
}
