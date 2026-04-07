// This file is loaded via vitest setupFiles before any test imports.
// Set environment variables that env.ts requires.
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/test';
process.env['INTERNAL_API_KEY'] = 'test-key';
process.env['EVENT_BUS_DRIVER'] = 'memory';
process.env['LOG_LEVEL'] = 'silent';
process.env['TIMEOUT_POLL_ENABLED'] = 'false';
