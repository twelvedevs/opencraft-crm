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
    PORT: parseInt(optional('PORT', '3005'), 10),
    INTERNAL_API_KEY: required('INTERNAL_API_KEY'),
    EVENT_BUS_DRIVER: required('EVENT_BUS_DRIVER'),
    TIMEOUT_POLL_ENABLED: optional('TIMEOUT_POLL_ENABLED', 'true'),
    LOG_LEVEL: optional('LOG_LEVEL', 'info'),
  };

  const driver = base.EVENT_BUS_DRIVER;

  if (driver === 'eventbridge') {
    return {
      ...base,
      EVENTBRIDGE_BUS_NAME: required('EVENTBRIDGE_BUS_NAME'),
      AWS_REGION: required('AWS_REGION'),
    };
  }

  return base;
}

export const env = parseEnv();
