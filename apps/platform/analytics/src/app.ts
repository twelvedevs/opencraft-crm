import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
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

export async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);
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

  return app;
}
