import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { createDb } from './db.js';
import rulesRoutes from './routes/rules.js';

const fastify = Fastify({ logger: true });

await fastify.register(sensible);

fastify.get('/healthz', async () => {
  return { ok: true };
});

const db = createDb();

await fastify.register(rulesRoutes, { db });

const port = parseInt(process.env['PORT'] ?? '3000', 10);

try {
  await fastify.listen({ port, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
