import { describe, expect, it } from 'vitest';
import { applyDerivedAppUrl, deriveAppUrl } from '../server/deploy.js';

describe('public address from the host', () => {
  it('uses Railway’s domain when APP_URL is blank, and never overrides an explicit one', () => {
    expect(deriveAppUrl({ RAILWAY_PUBLIC_DOMAIN: 'orbit-production.up.railway.app' })).toBe('https://orbit-production.up.railway.app');
    expect(deriveAppUrl({ RAILWAY_STATIC_URL: 'https://orbit.up.railway.app' })).toBe('https://orbit.up.railway.app');
    expect(deriveAppUrl({ APP_URL: 'https://mine.example.com', RAILWAY_PUBLIC_DOMAIN: 'other.up.railway.app' })).toBe('https://mine.example.com');
    expect(deriveAppUrl({})).toBeUndefined();
    expect(deriveAppUrl({ RAILWAY_PUBLIC_DOMAIN: 'bad domain/with spaces' })).toBeUndefined();
  });

  it('fills APP_URL once', () => {
    const env: Record<string, string | undefined> = { RAILWAY_PUBLIC_DOMAIN: 'orbit.up.railway.app' };
    applyDerivedAppUrl(env);
    expect(env.APP_URL).toBe('https://orbit.up.railway.app');
  });
});
