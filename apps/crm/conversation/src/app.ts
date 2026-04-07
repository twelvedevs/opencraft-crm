import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { createLogger } from '@ortho/logger';
import type { EventBus } from '@ortho/event-bus';
import type { Knex } from 'knex';
import type { Queue } from 'bullmq';
import '@ortho/auth-middleware';
import { env } from './env.js';
import { conversationsRoute } from './routes/conversations.js';
import { messagesRoute } from './routes/messages.js';
import { notesRoute } from './routes/notes.js';
import { scheduledRoute } from './routes/scheduled.js';
import { aiRoute } from './routes/ai.js';
import { bulkSendsRoute } from './routes/bulk-sends.js';
import { settingsRoute } from './routes/settings.js';

export interface AppQueues {
  scheduledSendQueue?: Queue;
  bulkSendQueue?: Queue;
}

export async function buildApp(db: Knex, eventBus: EventBus, queues?: AppQueues): Promise<FastifyInstance> {
  const log = createLogger('crm-conversation');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);

  // Internal auth hook at root scope
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/health')) return;

    const apiKey = request.headers['x-internal-api-key'];
    if (apiKey !== env.INTERNAL_API_KEY) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    // Parse forwarded user context from API Gateway
    const userId = request.headers['x-user-id'] as string | undefined;
    const role = request.headers['x-user-role'] as string | undefined;
    const locationsHeader = request.headers['x-user-locations'] as string | undefined;

    if (userId && role) {
      const locations = locationsHeader ? locationsHeader.split(',').filter(Boolean) : [];
      request.user = {
        sub: userId,
        role,
        locations,
        must_change_password: false,
      };
    }
  });

  app.get('/health', async () => ({ ok: true }));

  // Route plugins — bulk-sends and settings registered before /:id to avoid param conflicts
  if (queues?.bulkSendQueue) {
    await app.register(bulkSendsRoute, { prefix: '/conversations', db, bulkSendQueue: queues.bulkSendQueue });
  }
  await app.register(settingsRoute, { prefix: '/conversations', db });

  await app.register(conversationsRoute, { prefix: '/conversations', db });
  await app.register(messagesRoute, { prefix: '/conversations', db });
  await app.register(notesRoute, { prefix: '/conversations', db });
  if (queues?.scheduledSendQueue) {
    await app.register(scheduledRoute, { prefix: '/conversations', db, scheduledSendQueue: queues.scheduledSendQueue });
  }

  await app.register(aiRoute, { prefix: '/conversations', db });

  return app;
}
