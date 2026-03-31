import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import authPlugin from './plugins/auth.js';
import { createDb } from './db.js';
import { SequenceDefinitionsRepository } from './repositories/sequence-definitions.repo.js';
import { SequenceVersionsRepository } from './repositories/sequence-versions.repo.js';
import { EnrollmentsRepository } from './repositories/enrollments.repo.js';
import { StepExecutionsRepository } from './repositories/step-executions.repo.js';
import { VersioningService } from './services/versioning.service.js';
import { EnrollmentManager } from './services/enrollment-manager.js';
import { runStartupScan } from './services/startup-scanner.js';
import safetyNetPollerPlugin from './services/safety-net-poller.js';
import sequencesRoutes from './routes/sequences.js';
import enrollmentsRoutes from './routes/enrollments.js';
import statsRoutes from './routes/stats.js';
import { createStepQueue, type StepJobData } from './queue/step-queue.js';
import type { Logger } from 'pino';
import { createPublisher, type NurturingPublisher } from './events/publisher.js';

export interface CreateAppResult {
  fastify: FastifyInstance;
  stepExecutionsRepo: StepExecutionsRepository;
  queue: Queue<StepJobData> | null;
}

export async function createApp(opts?: {
  queue?: Queue<StepJobData> | null;
  publisher?: NurturingPublisher | null;
  redis?: Redis | null;
}): Promise<CreateAppResult> {
  const fastify = Fastify({ logger: true });
  const db = createDb();
  const definitionsRepo = new SequenceDefinitionsRepository(db);
  const versionsRepo = new SequenceVersionsRepository(db);
  const enrollmentsRepo = new EnrollmentsRepository(db);
  const stepExecutionsRepo = new StepExecutionsRepository(db);
  const versioningService = new VersioningService(definitionsRepo, versionsRepo);

  let queue: Queue<StepJobData> | null;
  if (opts !== undefined && 'queue' in opts) {
    queue = opts.queue ?? null;
  } else {
    const redisUrl = process.env['REDIS_URL'];
    queue = redisUrl ? createStepQueue(redisUrl) : null;
  }

  let publisher: NurturingPublisher | null;
  if (opts !== undefined && 'publisher' in opts) {
    publisher = opts.publisher ?? null;
  } else {
    try {
      publisher = createPublisher();
    } catch (_err) {
      publisher = null;
    }
  }

  const redis = opts?.redis ?? null;

  const enrollmentManager = new EnrollmentManager(
    db,
    definitionsRepo,
    versionsRepo,
    enrollmentsRepo,
    stepExecutionsRepo,
    queue,
  );

  await fastify.register(sensible);
  await fastify.register(authPlugin);
  await fastify.register(sequencesRoutes, { definitionsRepo, versionsRepo, versioningService });
  await fastify.register(enrollmentsRoutes, { enrollmentManager, enrollmentsRepo, stepExecutionsRepo, db, stepQueue: queue, publisher });
  await fastify.register(statsRoutes, { definitionsRepo, versionsRepo, enrollmentsRepo });

  if (redis && queue) {
    await fastify.register(safetyNetPollerPlugin, { stepExecutionsRepo, stepQueue: queue, redis, logger: fastify.log as Logger });
  }

  fastify.get('/healthz', async () => {
    return { ok: true };
  });

  return { fastify, stepExecutionsRepo, queue };
}

async function main(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) {
    console.warn('REDIS_URL is not set — step queue and safety-net poller will be disabled');
  }

  const queue = redisUrl ? createStepQueue(redisUrl) : null;
  const redis = redisUrl ? new Redis(redisUrl) : null;
  const { fastify, stepExecutionsRepo } = await createApp({ queue, redis });
  const port = parseInt(process.env['PORT'] ?? '3000', 10);

  try {
    await fastify.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  if (queue) {
    void runStartupScan({ stepExecutionsRepo, stepQueue: queue, logger: fastify.log as Logger }).catch(
      (err) => fastify.log.error(err, 'startup-scanner: unhandled error'),
    );
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
