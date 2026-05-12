const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

export const env = {
  PORT: parseInt(optional('PORT', '3010'), 10),
  DATABASE_URL: required('DATABASE_URL'),
  REDIS_URL: required('REDIS_URL'),
  AWS_REGION: required('AWS_REGION'),
  S3_BUCKET: required('S3_BUCKET'),
  PIPELINE_ENGINE_URL: required('PIPELINE_ENGINE_URL'),
  LEAD_SERVICE_URL: required('LEAD_SERVICE_URL'),
  IMPORT_SERVICE_API_KEY: required('IMPORT_SERVICE_API_KEY'),
  IDENTITY_JWKS_URL: required('IDENTITY_JWKS_URL'),
};
