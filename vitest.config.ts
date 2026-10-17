import { defineConfig } from 'vitest/config';

// Tests are storage-agnostic: run with DATABASE_URL unset for memory mode, or set it for Postgres mode.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { DEMO_MODE: 'false', NODE_ENV: 'test', AI_PROVIDER: 'rules' },
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
});
