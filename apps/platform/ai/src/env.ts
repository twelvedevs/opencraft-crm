import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvSchema = Type.Object({
  DATABASE_URL: Type.String(),
  PORT: Type.Optional(Type.Integer()),
  ARIZE_PHOENIX_ENDPOINT: Type.Optional(Type.String()),
});

type Env = Static<typeof EnvSchema> & { PORT: number };

function parseEnv(): Env {
  const raw = {
    DATABASE_URL: process.env['DATABASE_URL'],
    PORT: process.env['PORT'] !== undefined ? parseInt(process.env['PORT'], 10) : undefined,
    ARIZE_PHOENIX_ENDPOINT: process.env['ARIZE_PHOENIX_ENDPOINT'],
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
