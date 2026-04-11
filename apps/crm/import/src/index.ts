import Fastify, { type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { authPlugin } from '@ortho/auth-middleware';
import { createLogger } from '@ortho/logger';
import { openapiPlugin } from '@ortho/openapi';
import { S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import db, { destroy } from './db.js';
import { env } from './env.js';
import { ImportRepository } from './repositories/import.repo.js';
import { ImportRowRepository } from './repositories/import-row.repo.js';
import { ColumnMappingRepository } from './repositories/column-mapping.repo.js';
import { PipelineEngineClient } from './clients/pipeline-engine.js';
import { LeadServiceClient } from './clients/lead-service.js';
import { ImportService } from './services/import.service.js';
import { startWorker, type ImportJobData } from './workers/import-job.js';
import { mappingsRoutes } from './routes/mappings.js';
import { importsRoutes } from './routes/imports.js';
import { rowsRoutes } from './routes/rows.js';
import { actionsRoutes } from './routes/actions.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const log = createLogger('crm-import');

// ---------------------------------------------------------------------------
// Run migrations on startup
// ---------------------------------------------------------------------------
await db.migrate.latest({
  directory: './migrations',
  schemaName: 'crm_imports',
  tableName: 'knex_migrations',
  loadExtensions: ['.ts'],
});
log.info('Migrations complete');

// ---------------------------------------------------------------------------
// External clients
// ---------------------------------------------------------------------------
const s3Client = new S3Client({ region: env.AWS_REGION });
const importQueue = new Queue<ImportJobData>('import-jobs', {
  connection: { url: env.REDIS_URL },
});
const pipelineClient = new PipelineEngineClient();
const leadClient = new LeadServiceClient();

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------
const importRepo = new ImportRepository(db);
const importRowRepo = new ImportRowRepository(db);
const columnMappingRepo = new ColumnMappingRepository(db);

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
const importService = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

// ---------------------------------------------------------------------------
// Fastify app
// ---------------------------------------------------------------------------
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

await app.register(sensible);
await app.register(multipart);

await app.register(openapiPlugin, {
  title: 'Data Import Service',
  description: 'Ortho2 CSV parsing, column mapping, and 5-tier match logic',
  tags: [
    { name: 'Imports', description: 'Import job management' },
    { name: 'Mappings', description: 'Column mapping templates' },
    { name: 'Rows', description: 'Import row inspection' },
    { name: 'Actions', description: 'Confirm, cancel, and undo imports' },
  ],
});

// Health check (unauthenticated)
app.get('/health', { schema: { hide: true } as object }, async () => ({ ok: true }));

// ---------------------------------------------------------------------------
// Authenticated scope — all routes
// ---------------------------------------------------------------------------
await app.register(async (scope) => {
  await scope.register(authPlugin, { jwksUrl: env.IDENTITY_JWKS_URL });

  // mappings first to prevent 'column-mappings' matching :id param
  await scope.register(mappingsRoutes({ columnMappingRepo }));
  await scope.register(importsRoutes({ importService, s3Client, importQueue }));
  await scope.register(rowsRoutes({ importService, importRowRepo }));
  await scope.register(actionsRoutes({ importService, importQueue }));
});

// ---------------------------------------------------------------------------
// BullMQ worker (same process)
// ---------------------------------------------------------------------------
const worker = startWorker(importQueue, db, s3Client, pipelineClient, leadClient, log);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
await app.listen({ port: env.PORT, host: '0.0.0.0' });
log.info({ port: env.PORT }, 'Import Service listening');

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
process.on('SIGTERM', async () => {
  log.info('SIGTERM received — shutting down');
  await worker.close();
  await app.close();
  await destroy();
  process.exit(0);
});
