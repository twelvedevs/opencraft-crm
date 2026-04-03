const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

const optionalBool = (key: string, fallback: boolean): boolean => {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val === 'true' || val === '1';
};

function parseEnv() {
  const AUTH_PROVIDER = required('AUTH_PROVIDER');
  if (AUTH_PROVIDER !== 'supabase' && AUTH_PROVIDER !== 'auth0') {
    throw new Error(`AUTH_PROVIDER must be 'supabase' or 'auth0', got '${AUTH_PROVIDER}'`);
  }

  const base = {
    DATABASE_URL: required('DATABASE_URL'),
    REDIS_URL: required('REDIS_URL'),
    AUTH_PROVIDER: AUTH_PROVIDER as 'supabase' | 'auth0',
    IDENTITY_PRIVATE_KEY: required('IDENTITY_PRIVATE_KEY'),
    IDENTITY_JWKS_KEYS: JSON.parse(required('IDENTITY_JWKS_KEYS')) as Record<string, unknown>[],
    INTERNAL_API_SECRET: required('INTERNAL_API_SECRET'),
    CORS_ORIGIN: required('CORS_ORIGIN')
      .split(',')
      .map((s) => s.trim()),
    IDENTITY_JWKS_URL: optional(
      'IDENTITY_JWKS_URL',
      `http://localhost:${parseInt(optional('PORT', '3000'), 10)}/identity/.well-known/jwks.json`,
    ),
    LOG_LEVEL: optional('LOG_LEVEL', 'info'),
    PORT: parseInt(optional('PORT', '3000'), 10),
    PASSWORD_MIN_LENGTH: parseInt(optional('PASSWORD_MIN_LENGTH', '12'), 10),
    PASSWORD_REQUIRE_UPPERCASE: optionalBool('PASSWORD_REQUIRE_UPPERCASE', true),
    PASSWORD_REQUIRE_LOWERCASE: optionalBool('PASSWORD_REQUIRE_LOWERCASE', true),
    PASSWORD_REQUIRE_NUMBER: optionalBool('PASSWORD_REQUIRE_NUMBER', true),
    PASSWORD_REQUIRE_SPECIAL: optionalBool('PASSWORD_REQUIRE_SPECIAL', true),
  };

  // Provider-specific vars
  if (AUTH_PROVIDER === 'supabase') {
    return {
      ...base,
      SUPABASE_URL: required('SUPABASE_URL'),
      SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
    };
  }

  return {
    ...base,
    AUTH0_DOMAIN: required('AUTH0_DOMAIN'),
    AUTH0_CLIENT_ID: required('AUTH0_CLIENT_ID'),
    AUTH0_CLIENT_SECRET: required('AUTH0_CLIENT_SECRET'),
  };
}

export const env = parseEnv();
