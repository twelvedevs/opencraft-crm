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
  NODE_ENV: optional('NODE_ENV', 'development'),
  IDENTITY_JWKS_URL: required('IDENTITY_JWKS_URL'),
  LEAD_SERVICE_URL: required('LEAD_SERVICE_URL'),
  LEAD_SERVICE_API_KEY: required('LEAD_SERVICE_API_KEY'),
  MESSAGING_SERVICE_URL: required('MESSAGING_SERVICE_URL'),
  DEFAULT_REFERRAL_LANDING_URL: required('DEFAULT_REFERRAL_LANDING_URL'),
  REFERRAL_BASE_URL: required('REFERRAL_BASE_URL'),
  EVENT_BUS_DRIVER: optional('EVENT_BUS_DRIVER', 'eventbridge'),
  SQS_QUEUE_URL: required('SQS_QUEUE_URL'),
  AWS_REGION: optional('AWS_REGION', 'us-east-1'),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),
};
