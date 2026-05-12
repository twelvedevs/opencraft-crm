import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { env } from '../env.js';
import { uploadToS3, createPresignedGetUrl } from '../services/s3.js';
import { issuePrivateGetUrl } from '../services/signed-url.js';
import { derivePublicKey, derivePrivateKey } from '../lib/s3-key.js';
import * as mediaFilesRepo from '../repositories/media-files.js';
import { serviceAuthHook } from '../middleware/service-auth.js';

export async function internalRoutes(
  app: FastifyInstance,
  opts: { knex: Knex },
): Promise<void> {
  const { knex } = opts;

  // Apply service auth to all routes in this plugin
  app.addHook('preHandler', serviceAuthHook);

  app.post(
    '/media/internal/store',
    { schema: { tags: ['Internal'], summary: 'Store file from internal service' } as object },
    async (request, reply) => {
      let file: Awaited<ReturnType<typeof request.file>>;
      try {
        file = await request.file();
      } catch {
        return reply.status(400).send({ error: 'Invalid multipart request' });
      }

      if (!file) {
        return reply.status(400).send({ error: 'file field is required' });
      }

      // Collect fields from the multipart stream
      const fields = file.fields as Record<string, { value?: string } | undefined>;

      const tierField = fields.tier;
      const tier = tierField && 'value' in tierField ? tierField.value : undefined;
      if (!tier || (tier !== 'public' && tier !== 'private')) {
        return reply.status(400).send({ error: 'tier is required and must be public or private' });
      }

      const locationIdField = fields.location_id;
      const locationId = locationIdField && 'value' in locationIdField ? locationIdField.value : undefined;

      const purposeField = fields.purpose;
      const purpose = purposeField && 'value' in purposeField ? purposeField.value : undefined;

      // Buffer the file stream
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch {
        return reply.status(413).send({ error: 'File exceeds 20MB limit' });
      }

      // Check if file exceeded limit
      if (file.file.truncated) {
        return reply.status(413).send({ error: 'File exceeds 20MB limit' });
      }

      const uploadId = crypto.randomUUID();
      const fileUuid = crypto.randomUUID();
      const originalFilename = file.filename;
      const mimeType = file.mimetype;
      const ext = originalFilename.includes('.')
        ? originalFilename.substring(originalFilename.lastIndexOf('.') + 1)
        : '';

      // Derive S3 key
      const originalKey =
        tier === 'public'
          ? derivePublicKey(uploadId, fileUuid, ext)
          : derivePrivateKey(locationId ?? '', uploadId, fileUuid, ext);

      const bucket =
        tier === 'public' ? env.S3_PUBLIC_BUCKET : env.S3_PRIVATE_BUCKET;

      // Upload to S3
      await uploadToS3({
        bucket,
        key: originalKey,
        body: buffer,
        contentType: mimeType,
      });

      // Create media_files row directly as ready — NO image processing for internal store
      const fileId = crypto.randomUUID();
      await knex.transaction(async (trx) => {
        await mediaFilesRepo.createPending(trx, {
          id: fileId,
          upload_id: uploadId,
          tier: tier as 'public' | 'private',
          mime_type: mimeType,
          original_key: originalKey,
          original_filename: originalFilename,
          location_id: locationId ?? null,
          purpose: purpose ?? null,
          uploaded_by: env.SERVICE_CALLER_ID,
        });

        await trx('platform_media.media_files')
          .where({ id: fileId })
          .update({
            status: 'ready',
            file_size_bytes: buffer.length,
            confirmed_at: new Date(),
          });
      });

      // Build URL
      const urls: Record<string, string> = {};
      if (tier === 'public') {
        urls.original = `${env.CLOUDFRONT_BASE_URL}/${originalKey}`;
      } else {
        urls.original = await createPresignedGetUrl({
          bucket: env.S3_PRIVATE_BUCKET,
          key: originalKey,
          ttlSeconds: env.PRESIGNED_GET_TTL_SECONDS,
        });
      }

      return reply.status(200).send({
        file_id: fileId,
        urls,
      });
    },
  );

  app.get(
    '/media/internal/:file_id/signed-url',
    { schema: { tags: ['Internal'], summary: 'Get internal signed URL' } as object },
    async (request, reply) => {
      const { file_id } = request.params as { file_id: string };

      const file = await mediaFilesRepo.findById(knex, file_id);
      if (!file || file.status === 'deleted') {
        return reply.status(404).send({ error: 'File not found' });
      }

      if (file.tier === 'public') {
        return reply.status(400).send({ error: 'Use CloudFront URL for public files' });
      }

      const result = await issuePrivateGetUrl(knex, file);
      return reply.status(200).send(result);
    },
  );
}
