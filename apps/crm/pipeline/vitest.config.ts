import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    setupFiles: ['./test/integration/setup.ts'],
    testTimeout: 30_000,
  },
});
