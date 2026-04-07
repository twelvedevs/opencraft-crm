import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { createLogger } from '@ortho/logger';
import type { EventBus } from '@ortho/event-bus';
import type { Knex } from 'knex';
import { env } from './env.js';

export async function buildApp(db: Knex, eventBus: EventBus): Promise<FastifyInstance> {
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
  });

  app.get('/health', async () => ({ ok: true }));

  // Route stubs — will be replaced by route plugins in later stories
  // bulk-sends registered before /:id to avoid param conflicts
  await app.register(async (instance) => {
    instance.post('/bulk-sends', async (_req, reply) => reply.status(501).send({ error: 'not_implemented' }));
    instance.post('/', async (_req, reply) => reply.status(501).send({ error: 'not_implemented' }));
    instance.get('/', async (_req, reply) => reply.status(501).send({ error: 'not_implemented' }));
    instance.get('/:id', async (_req, reply) => reply.status(501).send({ error: 'not_implemented' }));
    instance.patch('/:id', async (_req, reply) => reply.status(501).send({ error: 'not_implemented' }));
    instance.post('/:id/read', async (_req, reply) => reply.status(501).send({ error: 'not_implemented' }));
    instance.post('/:id/messages', async (_req, reply) => reply.status(501).send({ error: 'not_implemented' }));
    instance.get('/:id/messages', async (_req, reply) => reply.status(501).send({ error: 'not_implemented' }));
  }, { prefix: '/conversations' });

  return app;
}
