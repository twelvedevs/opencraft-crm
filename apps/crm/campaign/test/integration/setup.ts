// This file is loaded via vitest setup before any test imports.
// Set environment variables that env.ts requires.
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/test';
process.env['IDENTITY_JWKS_URL'] = 'http://localhost:9999/.well-known/jwks.json';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['BULLMQ_REDIS_URL'] = process.env['BULLMQ_REDIS_URL'] ?? 'redis://localhost:6379';
process.env['SQS_QUEUE_URL'] = 'http://localhost:4566/000000000000/test-queue';
process.env['EVENTBRIDGE_BUS_NAME'] = 'test-bus';
process.env['AUDIENCE_ENGINE_URL'] = 'http://localhost:9998';
process.env['LEAD_SERVICE_URL'] = 'http://localhost:3000';
process.env['EMAIL_SERVICE_URL'] = 'http://localhost:3005';
process.env['TEMPLATE_SERVICE_URL'] = 'http://localhost:3006';
process.env['EVENT_BUS_DRIVER'] = 'memory';
process.env['LOG_LEVEL'] = 'silent';
