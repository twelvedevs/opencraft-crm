import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run all test files sequentially — integration tests share a Postgres schema
    // and would race each other if run in parallel.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
