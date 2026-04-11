// ---------------------------------------------------------------------------
// Config — reads and validates all environment variables at startup.
// Throws on any missing required variable so the service fails fast.
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid integer, got: ${raw}`);
  }
  return parsed;
}

export const config = {
  // Upstream service URLs
  LEAD_SERVICE_URL: requireEnv('LEAD_SERVICE_URL'),
  PIPELINE_SERVICE_URL: requireEnv('PIPELINE_SERVICE_URL'),
  CONVERSATION_SERVICE_URL: requireEnv('CONVERSATION_SERVICE_URL'),
  CAMPAIGN_SERVICE_URL: requireEnv('CAMPAIGN_SERVICE_URL'),
  REFERRAL_SERVICE_URL: requireEnv('REFERRAL_SERVICE_URL'),
  REPORTING_SERVICE_URL: requireEnv('REPORTING_SERVICE_URL'),
  IMPORT_SERVICE_URL: requireEnv('IMPORT_SERVICE_URL'),
  NOTIFICATION_SERVICE_URL: requireEnv('NOTIFICATION_SERVICE_URL'),
  IDENTITY_SERVICE_URL: requireEnv('IDENTITY_SERVICE_URL'),

  // Auth secrets
  LEAD_SERVICE_API_KEY: requireEnv('LEAD_SERVICE_API_KEY'),
  INTERNAL_API_SECRET: requireEnv('INTERNAL_API_SECRET'),

  // Optional numeric settings with defaults
  JWKS_CACHE_TTL_MS: optionalEnvInt('JWKS_CACHE_TTL_MS', 300_000),
  API_KEY_CACHE_TTL_MS: optionalEnvInt('API_KEY_CACHE_TTL_MS', 60_000),
  UPSTREAM_TIMEOUT_MS: optionalEnvInt('UPSTREAM_TIMEOUT_MS', 30_000),
  PORT: optionalEnvInt('PORT', 3000),
  MAX_BODY_SIZE_BYTES: optionalEnvInt('MAX_BODY_SIZE_BYTES', 1_048_576),
  IMPORT_MAX_BODY_SIZE_BYTES: optionalEnvInt('IMPORT_MAX_BODY_SIZE_BYTES', 5_242_880),
} as const;

export type Config = typeof config;
