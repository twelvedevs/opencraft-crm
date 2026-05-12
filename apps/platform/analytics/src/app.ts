import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { createLogger } from '@ortho/logger';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import { openapiPlugin } from '@ortho/openapi';
import { apiKeyAuthPlugin } from './plugins/api-key-auth.js';
import { healthRoutes } from './routes/health.js';
import { leadsRoutes } from './routes/metrics/leads.js';
import { pipelineRoutes } from './routes/metrics/pipeline.js';
import { conversionsRoutes } from './routes/metrics/conversions.js';
import { messagesRoutes } from './routes/metrics/messages.js';
import { adSpendRoutes } from './routes/metrics/ad-spend.js';
import { campaignsRoutes } from './routes/metrics/campaigns.js';
import { referralsRoutes } from './routes/metrics/referrals.js';
import { coordinatorsRoutes } from './routes/metrics/coordinators.js';
import { queryRoutes } from './routes/query.js';
import { adminRoutes } from './routes/admin.js';

export async function buildApp(pool: Pool, queue: Queue): Promise<FastifyInstance> {
  const log = createLogger('platform-analytics');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });

  await app.register(sensible);
  await app.register(requestLoggingPlugin, { logger: log });
  await app.register(openapiPlugin, {
    title: 'Analytics Service',
    description: 'Event ingestion pipeline and metric aggregation',
    tags: [
      { name: 'Metrics', description: 'Aggregated metric queries' },
      { name: 'Query', description: 'Ad-hoc raw event queries' },
      { name: 'Admin', description: 'Administrative operations' },
    ],
  });
  await app.register(apiKeyAuthPlugin);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  await app.register(healthRoutes, { pool });
  await app.register(leadsRoutes, { pool });
  await app.register(pipelineRoutes, { pool });
  await app.register(conversionsRoutes, { pool });
  await app.register(messagesRoutes, { pool });
  await app.register(adSpendRoutes, { pool });
  await app.register(campaignsRoutes, { pool });
  await app.register(referralsRoutes, { pool });
  await app.register(coordinatorsRoutes, { pool });
  await app.register(queryRoutes, { pool });
  await app.register(adminRoutes, { queue });

  return app;
}
