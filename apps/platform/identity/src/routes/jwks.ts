import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';

export async function jwksRoutes(app: FastifyInstance) {
  app.get('/identity/.well-known/jwks.json', async (_req, reply) => {
    return reply.send({ keys: env.IDENTITY_JWKS_KEYS });
  });
}
