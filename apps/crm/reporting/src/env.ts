const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

export const env = {
  PORT: parseInt(optional('PORT', '3009'), 10),
  DATABASE_URL: required('DATABASE_URL'),
  REDIS_URL: required('REDIS_URL'),
  ANALYTICS_SERVICE_URL: required('ANALYTICS_SERVICE_URL'),
  ANALYTICS_API_KEY: required('ANALYTICS_API_KEY'),
  MEDIA_SERVICE_URL: required('MEDIA_SERVICE_URL'),
  INTERNAL_API_SECRET: required('INTERNAL_API_SECRET'),
  EMAIL_SERVICE_URL: required('EMAIL_SERVICE_URL'),
  NOTIFICATION_SERVICE_URL: required('NOTIFICATION_SERVICE_URL'),
  CRM_BASE_URL: required('CRM_BASE_URL'),
  IDENTITY_JWKS_URL: required('IDENTITY_JWKS_URL'),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),
  LRU_CACHE_MAX: parseInt(optional('LRU_CACHE_MAX', '500'), 10),
  LRU_CACHE_TTL_MS: parseInt(optional('LRU_CACHE_TTL_MS', '300000'), 10),
};
