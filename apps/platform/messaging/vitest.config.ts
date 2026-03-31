import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'test-auth-token',
      TWILIO_STATUS_CALLBACK_URL: 'http://localhost:3000/webhooks/twilio/status',
      EVENT_BUS_DRIVER: 'redis',
    },
  },
});
