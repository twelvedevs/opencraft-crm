import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import authPlugin from '../../src/plugins/auth.js';
import { createDb } from '../../src/db.js';
import { SequenceDefinitionsRepository } from '../../src/repositories/sequence-definitions.repo.js';
import { SequenceVersionsRepository } from '../../src/repositories/sequence-versions.repo.js';
import { VersioningService } from '../../src/services/versioning.service.js';
import sequencesRoutes from '../../src/routes/sequences.js';
import type { FastifyInstance } from 'fastify';

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  const db = createDb();
  const definitionsRepo = new SequenceDefinitionsRepository(db);
  const versionsRepo = new SequenceVersionsRepository(db);
  const versioningService = new VersioningService(definitionsRepo, versionsRepo);

  await fastify.register(sensible);
  await fastify.register(authPlugin);
  await fastify.register(sequencesRoutes, { definitionsRepo, versionsRepo, versioningService });

  await fastify.ready();
  return fastify;
}
