import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvSchema = Type.Object({
  DATABASE_URL: Type.String(),
  REDIS_URL: Type.String(),
  SENDGRID_API_KEY: Type.String(),
  SENDGRID_WEBHOOK_SECRET_ID: Type.String(),
  EVENT_BUS_DRIVER: Type.Union([
    Type.Literal('eventbridge'),
    Type.Literal('redis'),
  ]),
  PORT: Type.Optional(Type.Integer()),
  SPAM_SCORE_THRESHOLD_DEFAULT: Type.Optional(Type.Number()),
});

type Env = Static<typeof EnvSchema> & { PORT: number };

function parseEnv(): Env {
  const raw = {
    DATABASE_URL: process.env['DATABASE_URL'],
    REDIS_URL: process.env['REDIS_URL'],
    SENDGRID_API_KEY: process.env['SENDGRID_API_KEY'],
    SENDGRID_WEBHOOK_SECRET_ID: process.env['SENDGRID_WEBHOOK_SECRET_ID'],
    EVENT_BUS_DRIVER: process.env['EVENT_BUS_DRIVER'],
    PORT: process.env['PORT'] !== undefined ? parseInt(process.env['PORT'], 10) : undefined,
    SPAM_SCORE_THRESHOLD_DEFAULT: process.env['SPAM_SCORE_THRESHOLD_DEFAULT'] !== undefined
      ? parseFloat(process.env['SPAM_SCORE_THRESHOLD_DEFAULT'])
      : undefined,
  };

  if (!Value.Check(EnvSchema, raw)) {
    const errors = [...Value.Errors(EnvSchema, raw)];
    const first = errors[0];
    const field = first ? first.path.replace(/^\//, '') : 'unknown';
    throw new Error(`Missing required env: ${field}`);
  }

  const parsed = raw as Static<typeof EnvSchema>;
  return { ...parsed, PORT: parsed.PORT ?? 3000 };
}

export const env = parseEnv();
