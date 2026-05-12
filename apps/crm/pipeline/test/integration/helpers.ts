import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import knexLib, { type Knex } from 'knex';
import { createLogger } from '@ortho/logger';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';
import { internalAuthPlugin } from '../../src/plugins/internal-auth.js';
import { membershipRoutes } from '../../src/routes/memberships.js';
import { transitionRoutes } from '../../src/routes/transitions.js';
import { conversionRoutes } from '../../src/routes/conversions.js';
import { closeRoutes } from '../../src/routes/close.js';
import { historyRoutes } from '../../src/routes/history.js';

const DATABASE_URL = process.env['DATABASE_URL'];
export const HAS_DB = !!DATABASE_URL && DATABASE_URL !== 'postgresql://localhost:5432/test';

export const LOCATION_ID = '00000000-0000-0000-0000-000000000001';
export const LEAD_ID_1 = '00000000-0000-0000-0000-000000000010';
export const LEAD_ID_2 = '00000000-0000-0000-0000-000000000011';

let db: Knex | undefined;

export function getDb(): Knex {
  if (!db) {
    db = knexLib({
      client: 'pg',
      connection: DATABASE_URL!,
      searchPath: ['crm_pipeline', 'public'],
    });
  }
  return db;
}

export async function runMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.latest({
    directory: './migrations',
    schemaName: 'crm_pipeline',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  });
}

export async function rollbackMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.rollback({
    directory: './migrations',
    schemaName: 'crm_pipeline',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  }, true);
}

export async function cleanup(): Promise<void> {
  if (db) {
    await rollbackMigrations();
    await db.destroy();
    db = undefined;
  }
}

export async function truncateTables(): Promise<void> {
  const knex = getDb();
  await knex.raw('TRUNCATE crm_pipeline.pipeline_stage_history, crm_pipeline.pipeline_memberships CASCADE');
}

export let mockDriver: MockDriver;

export async function buildTestApp(): Promise<FastifyInstance> {
  const log = createLogger('crm-pipeline-test');
  const app = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
  });

  await app.register(sensible);
  await app.register(internalAuthPlugin);

  app.get('/health', async () => ({ ok: true }));

  const testDb = getDb();
  mockDriver = new MockDriver();
  const eventBus = new EventBusImpl(mockDriver);

  await app.register(membershipRoutes, { prefix: '/pipeline', db: testDb, eventBus });
  await app.register(transitionRoutes, { prefix: '/pipeline', db: testDb, eventBus });
  await app.register(conversionRoutes, { prefix: '/pipeline', db: testDb, eventBus });
  await app.register(closeRoutes, { prefix: '/pipeline', db: testDb, eventBus });
  await app.register(historyRoutes, { prefix: '/pipeline', db: testDb, eventBus });

  return app;
}
