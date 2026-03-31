import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import authPlugin from './plugins/auth.js';
import { createDb } from './db.js';
import { SequenceDefinitionsRepository } from './repositories/sequence-definitions.repo.js';
import { SequenceVersionsRepository } from './repositories/sequence-versions.repo.js';
import { VersioningService } from './services/versioning.service.js';
import sequencesRoutes from './routes/sequences.js';

const fastify = Fastify({ logger: true });
const db = createDb();
const definitionsRepo = new SequenceDefinitionsRepository(db);
const versionsRepo = new SequenceVersionsRepository(db);
const versioningService = new VersioningService(definitionsRepo, versionsRepo);

await fastify.register(sensible);
await fastify.register(authPlugin);
await fastify.register(sequencesRoutes, { definitionsRepo, versionsRepo, versioningService });

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
