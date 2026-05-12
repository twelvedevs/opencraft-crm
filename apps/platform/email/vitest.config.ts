import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      SENDGRID_API_KEY: 'SG.test-key',
      SENDGRID_WEBHOOK_SIGNING_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-key',
      EVENT_BUS_DRIVER: 'redis',
      TEMPLATE_SERVICE_URL: 'http://template-service:3000',
    },
  },
});
