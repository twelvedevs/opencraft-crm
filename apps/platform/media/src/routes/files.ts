import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { env } from '../env.js';
import { createPresignedGetUrl } from '../services/s3.js';
import * as mediaFilesRepo from '../repositories/media-files.js';
import * as mediaVariantsRepo from '../repositories/media-variants.js';

export async function fileRoutes(
  app: FastifyInstance,
  opts: { knex: Knex },
): Promise<void> {
  const { knex } = opts;

  app.get(
    '/media/:file_id',
    async (request, reply) => {
      const { file_id } = request.params as { file_id: string };

      const file = await mediaFilesRepo.findById(knex, file_id);
      if (!file || file.status === 'deleted') {
        return reply.status(404).send({ error: 'File not found' });
      }

      // Access control for private files with location_id
      if (file.tier === 'private' && file.location_id != null) {
        const userLocationId = (request as any).user?.location_id;
        if (userLocationId !== file.location_id) {
          return reply.status(403).send({ error: 'Forbidden' });
        }
      }

      // Load variants
      const variants = await mediaVariantsRepo.findByFileId(knex, file_id);

      // Build URLs
      const urls: Record<string, string> = {};
      if (file.tier === 'public') {
        urls.original = `${env.CLOUDFRONT_BASE_URL}/${file.original_key}`;
        for (const v of variants) {
          urls[v.variant] = `${env.CLOUDFRONT_BASE_URL}/${v.s3_key}`;
        }
      } else {
        urls.original = await createPresignedGetUrl({
          bucket: env.S3_PRIVATE_BUCKET,
          key: file.original_key,
          ttlSeconds: env.PRESIGNED_GET_TTL_SECONDS,
        });
        for (const v of variants) {
          urls[v.variant] = await createPresignedGetUrl({
            bucket: env.S3_PRIVATE_BUCKET,
            key: v.s3_key,
            ttlSeconds: env.PRESIGNED_GET_TTL_SECONDS,
          });
        }
      }

      return reply.status(200).send({
        file_id: file.id,
        tier: file.tier,
        mime_type: file.mime_type,
        original_filename: file.original_filename,
        file_size_bytes: file.file_size_bytes,
        purpose: file.purpose,
        location_id: file.location_id,
        urls,
        created_at: file.created_at,
      });
    },
  );

  app.delete(
    '/media/:file_id',
    async (request, reply) => {
      const { file_id } = request.params as { file_id: string };

      const file = await mediaFilesRepo.findById(knex, file_id);
      if (!file || file.status === 'deleted') {
        return reply.status(404).send({ error: 'File not found' });
      }

      // Public files or files without location_id: only service token can delete (out of scope)
      if (file.tier === 'public' || file.location_id == null) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      // Private files with location_id: JWT location_id must match
      const userLocationId = (request as any).user?.location_id;
      if (userLocationId !== file.location_id) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      await mediaFilesRepo.softDelete(knex, file_id);
      return reply.status(204).send();
    },
  );
}
