const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

function parseEnv() {
  const base = {
    DATABASE_URL: required('DATABASE_URL'),
    PORT: parseInt(optional('PORT', '3000'), 10),
    IDENTITY_JWKS_URL: required('IDENTITY_JWKS_URL'),
    PIPELINE_ENGINE_URL: required('PIPELINE_ENGINE_URL'),
    AI_SERVICE_URL: required('AI_SERVICE_URL'),
    SERVICE_AUTH_TOKEN: required('SERVICE_AUTH_TOKEN'),
    LOG_LEVEL: optional('LOG_LEVEL', 'info'),
    SEARCH_SIMILARITY_THRESHOLD: parseFloat(optional('SEARCH_SIMILARITY_THRESHOLD', '0.2')),
    EVENT_BUS_DRIVER: required('EVENT_BUS_DRIVER'),
  };

  const driver = base.EVENT_BUS_DRIVER;

  if (driver === 'eventbridge') {
    return {
      ...base,
      EVENT_BRIDGE_BUS_NAME: required('EVENT_BRIDGE_BUS_NAME'),
      SQS_QUEUE_URL: required('SQS_QUEUE_URL'),
      AWS_REGION: required('AWS_REGION'),
      AWS_ACCESS_KEY_ID: required('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: required('AWS_SECRET_ACCESS_KEY'),
    };
  }

  if (driver === 'redis') {
    return {
      ...base,
      REDIS_URL: required('REDIS_URL'),
      EVENT_BUS_CONSUMER_GROUP: required('EVENT_BUS_CONSUMER_GROUP'),
    };
  }

  return base;
}

export const env = parseEnv();
