import crypto from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { env } from '../env.js';
import { createPresignedPutUrl } from '../services/s3.js';
import { derivePublicKey, derivePrivateKey } from '../lib/s3-key.js';
import * as mediaFilesRepo from '../repositories/media-files.js';
import * as uploadIntentsRepo from '../repositories/upload-intents.js';

const UploadUrlBody = Type.Object({
  filename: Type.String(),
  mime_type: Type.String(),
  tier: Type.Union([Type.Literal('public'), Type.Literal('private')]),
  location_id: Type.Optional(Type.String({ format: 'uuid' })),
  purpose: Type.Optional(Type.String()),
  file_size_bytes: Type.Optional(Type.Integer()),
});

export async function uploadRoutes(
  app: FastifyInstance,
  opts: { knex: Knex },
): Promise<void> {
  const { knex } = opts;

  app.post(
    '/media/upload-url',
    {
      schema: { body: UploadUrlBody },
    },
    async (request, reply) => {
      const body = request.body as {
        filename: string;
        mime_type: string;
        tier: 'public' | 'private';
        location_id?: string;
        purpose?: string;
        file_size_bytes?: number;
      };

      // Check file size limit
      if (body.file_size_bytes != null && body.file_size_bytes > env.MAX_FILE_SIZE_BYTES) {
        return reply.status(413).send({ error: 'File exceeds 20MB limit' });
      }

      // Private tier requires location_id
      if (body.tier === 'private' && !body.location_id) {
        return reply.status(400).send({ error: 'location_id is required for private tier' });
      }

      const uploadId = crypto.randomUUID();
      const fileUuid = crypto.randomUUID();
      const ext = body.filename.includes('.')
        ? body.filename.substring(body.filename.lastIndexOf('.') + 1)
        : '';

      // Derive S3 key
      const originalKey =
        body.tier === 'public'
          ? derivePublicKey(uploadId, fileUuid, ext)
          : derivePrivateKey(body.location_id!, uploadId, fileUuid, ext);

      const bucket =
        body.tier === 'public' ? env.S3_PUBLIC_BUCKET : env.S3_PRIVATE_BUCKET;

      // Create presigned PUT URL
      const uploadUrl = await createPresignedPutUrl({
        bucket,
        key: originalKey,
        contentType: body.mime_type,
        ttlSeconds: env.PRESIGNED_PUT_TTL_SECONDS,
        maxSizeBytes: env.MAX_FILE_SIZE_BYTES,
      });

      const expiresAt = new Date(
        Date.now() + env.PRESIGNED_PUT_TTL_SECONDS * 1000,
      );

      // Insert media_files and upload_intents in a single transaction
      const fileId = crypto.randomUUID();

      await knex.transaction(async (trx) => {
        await mediaFilesRepo.createPending(trx, {
          id: fileId,
          upload_id: uploadId,
          tier: body.tier,
          mime_type: body.mime_type,
          original_key: originalKey,
          original_filename: body.filename,
          location_id: body.location_id ?? null,
          purpose: body.purpose ?? null,
          uploaded_by: (request as any).user.sub,
        });

        await uploadIntentsRepo.createIntent(trx, {
          id: uploadId,
          file_id: fileId,
          presigned_url: uploadUrl,
          expires_at: expiresAt,
        });
      });

      return reply.status(200).send({
        upload_id: uploadId,
        upload_url: uploadUrl,
        expires_at: expiresAt.toISOString(),
      });
    },
  );
}
