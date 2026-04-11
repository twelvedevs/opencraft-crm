// This file is loaded via vitest setup before any test imports.
// Set environment variables that env.ts requires.
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/test_imports';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['AWS_REGION'] = 'us-east-1';
process.env['S3_BUCKET'] = 'test-bucket';
process.env['PIPELINE_ENGINE_URL'] = 'http://localhost:4001';
process.env['LEAD_SERVICE_URL'] = 'http://localhost:4002';
process.env['IMPORT_SERVICE_API_KEY'] = 'test-key';
process.env['IDENTITY_JWKS_URL'] = 'http://localhost:4003/.well-known/jwks.json';
process.env['LOG_LEVEL'] = 'silent';
