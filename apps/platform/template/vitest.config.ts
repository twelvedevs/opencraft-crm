import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share a real Postgres database — run files sequentially
    // to prevent schema reset race conditions.
    fileParallelism: false,
  },
});
