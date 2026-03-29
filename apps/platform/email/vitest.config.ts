import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      SENDGRID_API_KEY: 'SG.test-key',
      SENDGRID_WEBHOOK_SECRET_ID: 'test-secret-id',
      EVENT_BUS_DRIVER: 'redis',
    },
  },
});
