import { defineConfig } from 'vitest/config';

// Frozen wall-clock budgets, one file at a time in a single fork so no other
// suite competes for the CPU while they measure.
export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: 'default',
  },
});
