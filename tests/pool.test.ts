import { describe, expect, it } from 'vitest';
import { wantsSsl } from '../server/pool.js';

const prod = { NODE_ENV: 'production' };

describe('database TLS', () => {
  it('uses TLS for managed hosts in production', () => {
    expect(wantsSsl('postgres://u:p@viaduct.proxy.rlwy.net:5432/railway', prod)).toBe(true);
    expect(wantsSsl('postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/db', prod)).toBe(true);
  });

  it('skips TLS for a compose service, localhost, or an explicit sslmode=disable', () => {
    expect(wantsSsl('postgres://orbit:orbit@postgres:5432/orbit', prod)).toBe(false);
    expect(wantsSsl('postgres://orbit:orbit@localhost:5432/orbit', prod)).toBe(false);
    expect(wantsSsl('postgres://orbit:orbit@127.0.0.1:5432/orbit', prod)).toBe(false);
    expect(wantsSsl('postgres://u:p@db.example.com/x?sslmode=disable', prod)).toBe(false);
  });

  it('lets DATABASE_SSL override everything and never forces TLS in development', () => {
    expect(wantsSsl('postgres://orbit:orbit@postgres:5432/orbit', { ...prod, DATABASE_SSL: 'true' })).toBe(true);
    expect(wantsSsl('postgres://u:p@viaduct.proxy.rlwy.net/x', { ...prod, DATABASE_SSL: 'false' })).toBe(false);
    expect(wantsSsl('postgres://u:p@viaduct.proxy.rlwy.net/x', { NODE_ENV: 'development' })).toBe(false);
  });
});
