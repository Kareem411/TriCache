import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals:     false,
    environment: 'node',
    include:     ['tests/**/*.test.ts'],
    // Live-Redis integration tests are opt-in (pnpm test:integration):
    // they need a reachable Redis and would otherwise make the default
    // suite's test count differ between machines (skipped vs executed),
    // breaking the README badge contract.
    exclude:     ['tests/integration/**'],
    testTimeout: 15_000,
    reporters:   ['verbose'],
    pool:        'forks',
  },
});
