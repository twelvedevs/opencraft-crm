// This file is loaded via vitest setup before any test imports.
// Set environment variables that env.ts requires.
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/test_conversations';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['BULLMQ_REDIS_URL'] = 'redis://localhost:6379';
process.env['EVENT_BUS_NAME'] = 'test-bus';
process.env['EVENT_BUS_DRIVER'] = 'mock';
process.env['INTERNAL_API_KEY'] = 'test-key';
process.env['MESSAGING_SERVICE_URL'] = 'http://localhost:3001';
process.env['LEAD_SERVICE_URL'] = 'http://localhost:3000';
process.env['AI_SERVICE_URL'] = 'http://localhost:3002';
process.env['AUDIENCE_ENGINE_URL'] = 'http://localhost:3003';
process.env['NOTIFICATION_SERVICE_URL'] = 'http://localhost:3004';
process.env['LOG_LEVEL'] = 'silent';
