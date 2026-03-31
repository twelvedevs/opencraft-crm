import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvSchema = Type.Object({
  DATABASE_URL: Type.String(),
  REDIS_URL: Type.String(),
  TWILIO_ACCOUNT_SID: Type.String(),
  TWILIO_AUTH_TOKEN: Type.String(),
  TWILIO_STATUS_CALLBACK_URL: Type.String(),
  EVENT_BUS_DRIVER: Type.Union([
    Type.Literal('eventbridge'),
    Type.Literal('redis'),
  ]),
  PORT: Type.Optional(Type.Integer()),
});

type Env = Static<typeof EnvSchema> & { PORT: number };

function parseEnv(): Env {
  const raw = {
    DATABASE_URL: process.env['DATABASE_URL'],
    REDIS_URL: process.env['REDIS_URL'],
    TWILIO_ACCOUNT_SID: process.env['TWILIO_ACCOUNT_SID'],
    TWILIO_AUTH_TOKEN: process.env['TWILIO_AUTH_TOKEN'],
    TWILIO_STATUS_CALLBACK_URL: process.env['TWILIO_STATUS_CALLBACK_URL'],
    EVENT_BUS_DRIVER: process.env['EVENT_BUS_DRIVER'],
    PORT: process.env['PORT'] !== undefined ? parseInt(process.env['PORT'], 10) : undefined,
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
