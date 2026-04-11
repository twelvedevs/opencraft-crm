import { type FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { requireRole, requireLocation } from '@ortho/auth-middleware';
import '@fastify/multipart';
import { Upload } from '@aws-sdk/lib-storage';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import type { ImportService } from '../services/import.service.js';
import { ImportServiceError } from '../services/import.service.js';
import type { ImportJobData } from '../workers/import-job.js';
import { env } from '../env.js';

const ALLOWED_IMPORT_TYPES = ['active_patients', 'completed_patients', 'scheduled_appointments', 'no_shows'] as const;

const rolePre = requireRole(['call_center_manager', 'marketing_manager']);
const locationPre = requireLocation();

const PostImportBodySchema = Type.Object({
  import_type: Type.Union(ALLOWED_IMPORT_TYPES.map((t) => Type.Literal(t))),
  location_id: Type.String({ format: 'uuid' }),
});

const GetImportsQuerySchema = Type.Object({
  location_id: Type.String({ format: 'uuid' }),
  import_type: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
});

const GetImportParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

export function importsRoutes(opts: {
  importService: ImportService;
  s3Client: S3Client;
  importQueue: Queue<ImportJobData>;
}) {
  const { importService, s3Client, importQueue } = opts;

  return async function (app: FastifyInstance): Promise<void> {
    /**
     * POST /imports — upload CSV and start parse_match
     */
    app.post(
      '/imports',
      {
        preHandler: [rolePre, locationPre],
      },
      async (req, reply) => {
        const data = await req.file();
        if (!data) {
          return reply.code(400).send({ error: 'missing_file' });
        }

        // Read fields from multipart
        const fields = data.fields as Record<string, { value?: string }>;
        const importType = fields['import_type']?.value;
        const locationId = fields['location_id']?.value;

        if (!importType || !ALLOWED_IMPORT_TYPES.includes(importType as typeof ALLOWED_IMPORT_TYPES[number])) {
          return reply.code(400).send({ error: 'invalid_import_type' });
        }
        if (!locationId) {
          return reply.code(400).send({ error: 'missing_location_id' });
        }

        const importId = crypto.randomUUID();
        const fileKey = `imports/${importId}/raw.csv`;

        // Stream directly to S3 — no buffering
        const upload = new Upload({
          client: s3Client,
          params: {
            Bucket: env.S3_BUCKET,
            Key: fileKey,
            Body: data.file,
            ContentType: 'text/csv',
          },
        });
        await upload.done();

        const record = await importService.createImport({
          importId,
          locationId,
          importType,
          uploadedBy: req.user!.sub,
          fileName: data.filename,
          fileKey,
        });

        await importQueue.add('import-job', { import_id: importId, phase: 'parse_match' }, { attempts: 1, removeOnComplete: true, removeOnFail: false });

        return reply.code(201).send(record);
      },
    );

    /**
     * GET /imports — list imports for a location
     */
    app.get(
      '/imports',
      {
        schema: { querystring: GetImportsQuerySchema },
        preHandler: [rolePre, locationPre],
      },
      async (req, reply) => {
        const q = req.query as {
          location_id: string;
          import_type?: string;
          status?: string;
          cursor?: string;
        };

        const result = await importService.listImports(
          q.location_id,
          { import_type: q.import_type, status: q.status },
          q.cursor,
        );

        return reply.code(200).send(result);
      },
    );

    /**
     * GET /imports/:id — get a single import
     */
    app.get(
      '/imports/:id',
      {
        schema: { params: GetImportParamsSchema },
        preHandler: [rolePre],
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        try {
          const record = await importService.getImport(id);
          return reply.code(200).send(record);
        } catch (err) {
          if (err instanceof ImportServiceError) {
            return reply.code(err.statusCode).send(err.body);
          }
          throw err;
        }
      },
    );
  };
}
