import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import authPlugin from './plugins/auth.js';

const fastify = Fastify({ logger: true });

await fastify.register(sensible);
await fastify.register(authPlugin);

fastify.get('/healthz', async () => {
  return { ok: true };
});

const port = parseInt(process.env['PORT'] ?? '3000', 10);

try {
  await fastify.listen({ port, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

process.on('SIGTERM', async () => {
  await fastify.close();
});
