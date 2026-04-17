import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { createLogger } from '@ortho/logger';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
import { openapiPlugin } from '@ortho/openapi';
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
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });

  await app.register(sensible);
  await app.register(requestLoggingPlugin, { logger: log });

  await app.register(openapiPlugin, {
    title: 'Conversation Service',
    description: 'SMS inbox per location — conversation threading and AI-assisted messaging',
    tags: [
      { name: 'Conversations', description: 'Conversation management' },
      { name: 'Messages', description: 'Message sending and retrieval' },
      { name: 'Notes', description: 'Internal staff notes' },
      { name: 'Bulk Sends', description: 'Bulk SMS to segments' },
      { name: 'AI', description: 'AI-assisted reply drafting and summaries' },
      { name: 'Scheduled Messages', description: 'Future-dated message scheduling' },
      { name: 'Settings', description: 'Location inbox settings' },
    ],
  });

  // Internal auth hook at root scope
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/health')) return;

    const apiKey = request.headers['x-internal-api-key'];
    const expected = Buffer.from(env.INTERNAL_API_KEY);
    const actual = Buffer.from(typeof apiKey === 'string' ? apiKey : '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
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

  app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ ok: true }));

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
