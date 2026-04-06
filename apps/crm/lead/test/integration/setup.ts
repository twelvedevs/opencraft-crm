// This file is loaded via vitest setup before any test imports.
// Set environment variables that env.ts requires.
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/test';
process.env['IDENTITY_JWKS_URL'] = 'http://localhost:9999/.well-known/jwks.json';
process.env['PIPELINE_ENGINE_URL'] = 'http://localhost:9998';
process.env['AI_SERVICE_URL'] = 'http://localhost:9997';
process.env['SERVICE_AUTH_TOKEN'] = 'test-service-token-12345';
process.env['EVENT_BUS_DRIVER'] = 'memory';
process.env['LOG_LEVEL'] = 'silent';
