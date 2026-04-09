const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

export const env = {
  DATABASE_URL: required('DATABASE_URL'),
  PORT: parseInt(optional('PORT', '3000'), 10),
  REDIS_URL: required('REDIS_URL'),
  BULLMQ_REDIS_URL: required('BULLMQ_REDIS_URL'),
  SQS_QUEUE_URL: required('SQS_QUEUE_URL'),
  EVENTBRIDGE_BUS_NAME: required('EVENTBRIDGE_BUS_NAME'),
  AUDIENCE_ENGINE_URL: required('AUDIENCE_ENGINE_URL'),
  LEAD_SERVICE_URL: required('LEAD_SERVICE_URL'),
  EMAIL_SERVICE_URL: required('EMAIL_SERVICE_URL'),
  TEMPLATE_SERVICE_URL: required('TEMPLATE_SERVICE_URL'),
  IDENTITY_JWKS_URL: required('IDENTITY_JWKS_URL'),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),
};
