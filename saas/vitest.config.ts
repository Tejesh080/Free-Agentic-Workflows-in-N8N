import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Each test gets its own database, so files could run in parallel — but a
    // single local Postgres is the shared resource here, and serialising keeps
    // connection counts predictable and failures readable.
    fileParallelism: false,
  },
});
