import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Knex } from 'knex';

export async function buildApp(db: Knex, jwtSecret: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

  app.decorate('db', db);
  app.decorate('jwtSecret', jwtSecret);

  app.get('/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  return app;
}
