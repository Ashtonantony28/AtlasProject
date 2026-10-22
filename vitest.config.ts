import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Wall-clock budgets run serially in `npm run test:perf` (vitest.perf.config.ts).
    exclude: [...configDefaults.exclude, 'test/perf/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    typecheck: { enabled: false },
    reporters: 'default',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage',
      thresholds: {
        'src/core/**': { lines: 90, branches: 88, functions: 96 },
      },
    },
  },
});
