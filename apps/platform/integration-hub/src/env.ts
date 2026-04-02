import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvSchema = Type.Object({
  NODE_ENV: Type.Union([
    Type.Literal('production'),
    Type.Literal('development'),
    Type.Literal('test'),
  ]),
  PORT: Type.Optional(Type.Integer()),
  DATABASE_URL: Type.String(),
  REDIS_URL: Type.String(),
  EVENT_BUS_DRIVER: Type.Union([
    Type.Literal('eventbridge'),
    Type.Literal('redis'),
  ]),
  EVENT_BRIDGE_BUS_NAME: Type.Optional(Type.String()),
  SQS_QUEUE_URL: Type.Optional(Type.String()),
  EVENT_BUS_CONSUMER_GROUP: Type.Optional(Type.String()),
  SECRETS_PROVIDER: Type.Union([
    Type.Literal('aws'),
    Type.Literal('env'),
  ]),
  INTEGRATION_HUB_ENCRYPTION_KEY: Type.Optional(Type.String()),
  JWT_MODE: Type.Union([
    Type.Literal('static'),
    Type.Literal('jwks'),
  ]),
  IDENTITY_SERVICE_PUBLIC_KEY: Type.Optional(Type.String()),
  IDENTITY_SERVICE_JWKS_URL: Type.Optional(Type.String()),
  JWT_ISSUER: Type.Optional(Type.String()),
  JWT_AUDIENCE: Type.Optional(Type.String()),
  OAUTH_STATE_SECRET: Type.String(),
  GOOGLE_ADS_CLIENT_ID: Type.String(),
  GOOGLE_ADS_CLIENT_SECRET: Type.String(),
  GOOGLE_ADS_DEVELOPER_TOKEN: Type.String(),
  GOOGLE_ADS_REDIRECT_URI: Type.String(),
  GOOGLE_ADS_WEBHOOK_VERIFY_TOKEN: Type.String(),
  META_APP_ID: Type.String(),
  META_APP_SECRET: Type.String(),
  META_WEBHOOK_VERIFY_TOKEN: Type.String(),
  LOG_LEVEL: Type.Optional(Type.String()),
});

type Env = Static<typeof EnvSchema> & {
  PORT: number;
  LOG_LEVEL: string;
};

function parseEnv(): Env {
  const raw = {
    NODE_ENV: process.env['NODE_ENV'],
    PORT: process.env['PORT'] !== undefined ? parseInt(process.env['PORT'], 10) : undefined,
    DATABASE_URL: process.env['DATABASE_URL'],
    REDIS_URL: process.env['REDIS_URL'],
    EVENT_BUS_DRIVER: process.env['EVENT_BUS_DRIVER'],
    EVENT_BRIDGE_BUS_NAME: process.env['EVENT_BRIDGE_BUS_NAME'],
    SQS_QUEUE_URL: process.env['SQS_QUEUE_URL'],
    EVENT_BUS_CONSUMER_GROUP: process.env['EVENT_BUS_CONSUMER_GROUP'],
    SECRETS_PROVIDER: process.env['SECRETS_PROVIDER'],
    INTEGRATION_HUB_ENCRYPTION_KEY: process.env['INTEGRATION_HUB_ENCRYPTION_KEY'],
    JWT_MODE: process.env['JWT_MODE'],
    IDENTITY_SERVICE_PUBLIC_KEY: process.env['IDENTITY_SERVICE_PUBLIC_KEY'],
    IDENTITY_SERVICE_JWKS_URL: process.env['IDENTITY_SERVICE_JWKS_URL'],
    JWT_ISSUER: process.env['JWT_ISSUER'],
    JWT_AUDIENCE: process.env['JWT_AUDIENCE'],
    OAUTH_STATE_SECRET: process.env['OAUTH_STATE_SECRET'],
    GOOGLE_ADS_CLIENT_ID: process.env['GOOGLE_ADS_CLIENT_ID'],
    GOOGLE_ADS_CLIENT_SECRET: process.env['GOOGLE_ADS_CLIENT_SECRET'],
    GOOGLE_ADS_DEVELOPER_TOKEN: process.env['GOOGLE_ADS_DEVELOPER_TOKEN'],
    GOOGLE_ADS_REDIRECT_URI: process.env['GOOGLE_ADS_REDIRECT_URI'],
    GOOGLE_ADS_WEBHOOK_VERIFY_TOKEN: process.env['GOOGLE_ADS_WEBHOOK_VERIFY_TOKEN'],
    META_APP_ID: process.env['META_APP_ID'],
    META_APP_SECRET: process.env['META_APP_SECRET'],
    META_WEBHOOK_VERIFY_TOKEN: process.env['META_WEBHOOK_VERIFY_TOKEN'],
    LOG_LEVEL: process.env['LOG_LEVEL'],
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
  };
}

export const env = parseEnv();
