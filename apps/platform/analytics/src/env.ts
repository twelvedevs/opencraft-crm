import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvSchema = Type.Object({
  DATABASE_URL: Type.String(),
  SQS_QUEUE_URL: Type.String(),
  IDENTITY_SERVICE_URL: Type.String(),
  REDIS_URL: Type.String(),
  ADMIN_RECOMPUTE_KEY: Type.String(),
  PORT: Type.Optional(Type.Integer()),
  LOG_LEVEL: Type.Optional(Type.String()),
  API_KEY_CACHE_TTL_SECONDS: Type.Optional(Type.Integer()),
  SQS_POLLING_INTERVAL_MS: Type.Optional(Type.Integer()),
  SQS_BATCH_SIZE: Type.Optional(Type.Integer()),
  SQS_CONCURRENCY: Type.Optional(Type.Integer()),
});

type Env = Static<typeof EnvSchema> & {
  PORT: number;
  LOG_LEVEL: string;
  API_KEY_CACHE_TTL_SECONDS: number;
  SQS_BATCH_SIZE: number;
  SQS_CONCURRENCY: number;
};

function parseEnv(): Env {
  const raw = {
    DATABASE_URL: process.env['DATABASE_URL'],
    SQS_QUEUE_URL: process.env['SQS_QUEUE_URL'],
    IDENTITY_SERVICE_URL: process.env['IDENTITY_SERVICE_URL'],
    REDIS_URL: process.env['REDIS_URL'],
    ADMIN_RECOMPUTE_KEY: process.env['ADMIN_RECOMPUTE_KEY'],
    PORT: process.env['PORT'] !== undefined ? parseInt(process.env['PORT'], 10) : undefined,
    LOG_LEVEL: process.env['LOG_LEVEL'],
    API_KEY_CACHE_TTL_SECONDS:
      process.env['API_KEY_CACHE_TTL_SECONDS'] !== undefined
        ? parseInt(process.env['API_KEY_CACHE_TTL_SECONDS'], 10)
        : undefined,
    SQS_POLLING_INTERVAL_MS:
      process.env['SQS_POLLING_INTERVAL_MS'] !== undefined
        ? parseInt(process.env['SQS_POLLING_INTERVAL_MS'], 10)
        : undefined,
    SQS_BATCH_SIZE:
      process.env['SQS_BATCH_SIZE'] !== undefined
        ? parseInt(process.env['SQS_BATCH_SIZE'], 10)
        : undefined,
    SQS_CONCURRENCY:
      process.env['SQS_CONCURRENCY'] !== undefined
        ? parseInt(process.env['SQS_CONCURRENCY'], 10)
        : undefined,
  };

  if (!Value.Check(EnvSchema, raw)) {
    const errors = [...Value.Errors(EnvSchema, raw)];
    const first = errors[0];
    const field = first ? first.path.replace(/^\//, '') : 'unknown';
    throw new Error(`Missing required env: ${field}`);
  }

  const parsed = raw as Static<typeof EnvSchema>;
  return {
    ...parsed,
    PORT: parsed.PORT ?? 3000,
    LOG_LEVEL: parsed.LOG_LEVEL ?? 'info',
    API_KEY_CACHE_TTL_SECONDS: parsed.API_KEY_CACHE_TTL_SECONDS ?? 60,
    SQS_BATCH_SIZE: parsed.SQS_BATCH_SIZE ?? 10,
    SQS_CONCURRENCY: parsed.SQS_CONCURRENCY ?? 5,
  };
}

export const env = parseEnv();
