const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

export const env = {
  PORT: parseInt(optional('PORT', '3006'), 10),
  DATABASE_URL: required('DATABASE_URL'),
  REDIS_URL: required('REDIS_URL'),
  BULLMQ_REDIS_URL: required('BULLMQ_REDIS_URL'),
  EVENT_BUS_NAME: required('EVENT_BUS_NAME'),
  EVENT_BUS_CONSUMER_GROUP: optional('EVENT_BUS_CONSUMER_GROUP', 'crm-conversation'),
  AWS_REGION: optional('AWS_REGION', 'us-east-1'),
  INTERNAL_API_KEY: required('INTERNAL_API_KEY'),
  MESSAGING_SERVICE_URL: required('MESSAGING_SERVICE_URL'),
  LEAD_SERVICE_URL: required('LEAD_SERVICE_URL'),
  AI_SERVICE_URL: required('AI_SERVICE_URL'),
  AUDIENCE_ENGINE_URL: required('AUDIENCE_ENGINE_URL'),
  NOTIFICATION_SERVICE_URL: required('NOTIFICATION_SERVICE_URL'),
  AI_AGENT_CONCURRENCY: parseInt(optional('AI_AGENT_CONCURRENCY', '5'), 10),
  SCHEDULED_SEND_CONCURRENCY: parseInt(optional('SCHEDULED_SEND_CONCURRENCY', '10'), 10),
  BULK_SEND_CONCURRENCY: parseInt(optional('BULK_SEND_CONCURRENCY', '1'), 10),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),
};
