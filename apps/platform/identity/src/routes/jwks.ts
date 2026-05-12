import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';

export async function jwksRoutes(app: FastifyInstance) {
  app.get('/identity/.well-known/jwks.json', {
    schema: { tags: ['JWKS'], summary: 'Get public key set' } as object,
  }, async (_req, reply) => {
    return reply.send({ keys: env.IDENTITY_JWKS_KEYS });
  });
}
