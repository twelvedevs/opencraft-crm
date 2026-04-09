// This file is loaded via vitest setup before any test imports.
// Set environment variables that env.ts requires.
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/test';
process.env['IDENTITY_JWKS_URL'] = 'http://localhost:9999/.well-known/jwks.json';
process.env['LEAD_SERVICE_URL'] = 'http://localhost:3001';
process.env['LEAD_SERVICE_API_KEY'] = 'test-api-key';
process.env['MESSAGING_SERVICE_URL'] = 'http://localhost:3002';
process.env['DEFAULT_REFERRAL_LANDING_URL'] = 'https://example.com/referrals';
process.env['REFERRAL_BASE_URL'] = 'https://api.example.com';
process.env['EVENT_BUS_DRIVER'] = 'memory';
process.env['SQS_QUEUE_URL'] = 'http://localhost:4566/000000000000/test-queue';
process.env['LOG_LEVEL'] = 'silent';
