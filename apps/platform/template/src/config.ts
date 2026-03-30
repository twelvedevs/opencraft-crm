import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const ConfigSchema = Type.Object({
  DATABASE_URL: Type.String(),
  JWT_SECRET: Type.String(),
  PORT: Type.Optional(Type.Integer()),
});

type Config = Static<typeof ConfigSchema> & { PORT: number };

function parseConfig(): Config {
  const raw = {
    DATABASE_URL: process.env['DATABASE_URL'],
    JWT_SECRET: process.env['JWT_SECRET'],
    PORT: process.env['PORT'] !== undefined ? parseInt(process.env['PORT'], 10) : undefined,
  };

  if (!Value.Check(ConfigSchema, raw)) {
    const errors = [...Value.Errors(ConfigSchema, raw)];
    const first = errors[0];
    const field = first ? first.path.replace(/^\//, '') : 'unknown';
    throw new Error(`Missing required env: ${field}`);
  }

  const parsed = raw as Static<typeof ConfigSchema>;
  return { ...parsed, PORT: parsed.PORT ?? 3005 };
}

export const config = parseConfig();
