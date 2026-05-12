const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

function parseEnv() {
  return {
    DATABASE_URL: required('DATABASE_URL'),
    AWS_REGION: required('AWS_REGION'),
    S3_PUBLIC_BUCKET: required('S3_PUBLIC_BUCKET'),
    S3_PRIVATE_BUCKET: required('S3_PRIVATE_BUCKET'),
    CLOUDFRONT_BASE_URL: required('CLOUDFRONT_BASE_URL'),
    SERVICE_AUTH_TOKEN: required('SERVICE_AUTH_TOKEN'),
    SERVICE_CALLER_ID: required('SERVICE_CALLER_ID'),
    PORT: parseInt(optional('PORT', '3000'), 10),
    PRESIGNED_PUT_TTL_SECONDS: parseInt(optional('PRESIGNED_PUT_TTL_SECONDS', '900'), 10),
    PRESIGNED_GET_TTL_SECONDS: parseInt(optional('PRESIGNED_GET_TTL_SECONDS', '900'), 10),
    MAX_FILE_SIZE_BYTES: parseInt(optional('MAX_FILE_SIZE_BYTES', '20971520'), 10),
    CORS_ORIGIN: optional('CORS_ORIGIN', '*'),
    IDENTITY_JWKS_URL: optional('IDENTITY_JWKS_URL', 'http://localhost:3000/identity/.well-known/jwks.json'),
    LOG_LEVEL: optional('LOG_LEVEL', 'info'),
  };
}

export const env = parseEnv();
