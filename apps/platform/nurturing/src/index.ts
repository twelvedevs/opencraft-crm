import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import authPlugin from './plugins/auth.js';
import { createDb } from './db.js';
import { SequenceDefinitionsRepository } from './repositories/sequence-definitions.repo.js';
import { SequenceVersionsRepository } from './repositories/sequence-versions.repo.js';
import { VersioningService } from './services/versioning.service.js';
import sequencesRoutes from './routes/sequences.js';
import { createStepQueue, type StepJobData } from './queue/step-queue.js';

export async function createApp(opts?: { queue?: Queue<StepJobData> | null }): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: true });
  const db = createDb();
  const definitionsRepo = new SequenceDefinitionsRepository(db);
  const versionsRepo = new SequenceVersionsRepository(db);
  const versioningService = new VersioningService(definitionsRepo, versionsRepo);

  let queue: Queue<StepJobData> | null;
  if (opts !== undefined && 'queue' in opts) {
    queue = opts.queue ?? null;
  } else {
    const redisUrl = process.env['REDIS_URL'];
    queue = redisUrl ? createStepQueue(redisUrl) : null;
  }

  await fastify.register(sensible);
  await fastify.register(authPlugin);
  await fastify.register(sequencesRoutes, { definitionsRepo, versionsRepo, versioningService });

  fastify.get('/healthz', async () => {
    return { ok: true };
  });

  return fastify;
}

async function main(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) {
    console.warn('REDIS_URL is not set — step queue will be disabled');
  }

  const queue = redisUrl ? createStepQueue(redisUrl) : null;
  const fastify = await createApp({ queue });
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
}

// Only run when executed directly (not imported by tests)
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
