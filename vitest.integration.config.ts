import { defineConfig } from 'vitest/config';

/**
 * Integration-suite config (pnpm test:integration).
 *
 * The default vitest.config.ts excludes tests/integration/** so unit counts
 * stay deterministic for the README badge. This config inverts that: it runs
 * ONLY the live-Redis suite, which requires a reachable Redis
 * (TEST_REDIS_URL or redis://127.0.0.1:6379, e.g. docker run redis:7-alpine).
 */
export default defineConfig({
  test: {
    globals:     false,
    environment: 'node',
    include:     ['tests/integration/**/*.test.ts'],
    exclude:     [],
    testTimeout: 20_000,
    reporters:   ['verbose'],
    pool:        'forks',
  },
});
