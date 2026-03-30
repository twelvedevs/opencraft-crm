import Fastify from 'fastify';
import { config } from './config.js';

export const app = Fastify({ logger: true });

app.get('/health', async () => {
  return { status: 'ok' };
});

if (process.env['NODE_ENV'] !== 'test') {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
