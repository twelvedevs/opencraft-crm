import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../env.js';

export async function internalAuthPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith('/health')) return;

    const apiKey = request.headers['x-internal-api-key'];
    if (apiKey !== env.INTERNAL_API_KEY) {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }
  });
}
