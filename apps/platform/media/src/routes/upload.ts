import crypto from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { env } from '../env.js';
import { createPresignedPutUrl, uploadToS3, downloadFromS3, createPresignedGetUrl } from '../services/s3.js';
import { derivePublicKey, derivePrivateKey, deriveVariantKey } from '../lib/s3-key.js';
import * as mediaFilesRepo from '../repositories/media-files.js';
import * as mediaVariantsRepo from '../repositories/media-variants.js';
import * as uploadIntentsRepo from '../repositories/upload-intents.js';
import { processImage, isImageMimeType } from '../services/image-processor.js';

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

  app.post(
    '/media/confirm/:upload_id',
    async (request, reply) => {
      const { upload_id } = request.params as { upload_id: string };
      const userSub = (request as any).user.sub;

      // Look up upload intent
      const intent = await uploadIntentsRepo.findByUploadId(knex, upload_id);
      if (!intent) {
        return reply.status(404).send({ error: 'Upload intent not found' });
      }

      // Check expiry
      if (intent.expires_at < new Date()) {
        return reply.status(410).send({ error: 'Upload intent has expired' });
      }

      // Load media file
      const file = await mediaFilesRepo.findByUploadId(knex, upload_id);
      if (!file || file.status !== 'pending') {
        return reply.status(404).send({ error: 'File not found or already confirmed' });
      }

      // Check ownership
      if (file.uploaded_by !== userSub) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      // Download original from S3
      const bucket =
        file.tier === 'public' ? env.S3_PUBLIC_BUCKET : env.S3_PRIVATE_BUCKET;

      let buffer: Buffer;
      try {
        buffer = await downloadFromS3({ bucket, key: file.original_key });
      } catch {
        return reply.status(502).send({ error: 'Failed to download file from storage' });
      }

      // Process image variants if applicable
      let variantRows: Array<{ variantName: 'medium' | 'thumb'; s3Key: string; widthPx: number; sizeBytes: number }> = [];
      if (isImageMimeType(file.mime_type)) {
        const result = await processImage(buffer, file.original_key, bucket);
        variantRows = result.variants;
      }

      // Use transaction with conflict handling for double-tap protection
      await knex.transaction(async (trx) => {
        // Mark ready — use upload_id unique constraint to prevent double confirm
        const updated = await trx('platform_media.media_files')
          .where({ id: file.id, status: 'pending' })
          .update({
            status: 'ready',
            file_size_bytes: buffer.length,
            confirmed_at: new Date(),
          });

        if (updated === 0) {
          // Another concurrent call already confirmed
          return reply.status(404).send({ error: 'File not found or already confirmed' });
        }

        // Insert variants
        for (const v of variantRows) {
          await mediaVariantsRepo.insertVariant(trx, {
            file_id: file.id,
            variant: v.variantName,
            s3_key: v.s3Key,
            width_px: v.widthPx,
            size_bytes: v.sizeBytes,
          });
        }

        // Delete the upload intent
        await uploadIntentsRepo.deleteById(trx, upload_id);
      });

      // Build URLs
      const urls: Record<string, string> = {};
      if (file.tier === 'public') {
        urls.original = `${env.CLOUDFRONT_BASE_URL}/${file.original_key}`;
      } else {
        const signedOriginal = await createPresignedGetUrl({
          bucket: env.S3_PRIVATE_BUCKET,
          key: file.original_key,
          ttlSeconds: env.PRESIGNED_GET_TTL_SECONDS,
        });
        urls.original = signedOriginal;
      }

      for (const v of variantRows) {
        if (file.tier === 'public') {
          urls[v.variantName] = `${env.CLOUDFRONT_BASE_URL}/${v.s3Key}`;
        } else {
          urls[v.variantName] = await createPresignedGetUrl({
            bucket: env.S3_PRIVATE_BUCKET,
            key: v.s3Key,
            ttlSeconds: env.PRESIGNED_GET_TTL_SECONDS,
          });
        }
      }

      return reply.status(200).send({
        file_id: file.id,
        tier: file.tier,
        urls,
        location_id: file.location_id,
        created_at: file.created_at,
      });
    },
  );

  app.post(
    '/media/upload',
    async (request, reply) => {
      const userSub = (request as any).user.sub;

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

      // Private tier requires location_id
      if (tier === 'private' && !locationId) {
        return reply.status(400).send({ error: 'location_id is required for private tier' });
      }

      // Buffer the file stream
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch {
        return reply.status(413).send({ error: 'File exceeds 20MB limit' });
      }

      // Check if file exceeded limit (fastify/multipart sets file.file.truncated)
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
          : derivePrivateKey(locationId!, uploadId, fileUuid, ext);

      const bucket =
        tier === 'public' ? env.S3_PUBLIC_BUCKET : env.S3_PRIVATE_BUCKET;

      // Upload to S3
      await uploadToS3({
        bucket,
        key: originalKey,
        body: buffer,
        contentType: mimeType,
      });

      // Process image variants if applicable
      let variantRows: Array<{ variantName: 'medium' | 'thumb'; s3Key: string; widthPx: number; sizeBytes: number }> = [];
      if (isImageMimeType(mimeType)) {
        const result = await processImage(buffer, originalKey, bucket);
        variantRows = result.variants;
      }

      // Create media_files row directly as ready
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
          uploaded_by: userSub,
        });

        await trx('platform_media.media_files')
          .where({ id: fileId })
          .update({
            status: 'ready',
            file_size_bytes: buffer.length,
            confirmed_at: new Date(),
          });

        for (const v of variantRows) {
          await mediaVariantsRepo.insertVariant(trx, {
            file_id: fileId,
            variant: v.variantName,
            s3_key: v.s3Key,
            width_px: v.widthPx,
            size_bytes: v.sizeBytes,
          });
        }
      });

      // Build URLs
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

      for (const v of variantRows) {
        if (tier === 'public') {
          urls[v.variantName] = `${env.CLOUDFRONT_BASE_URL}/${v.s3Key}`;
        } else {
          urls[v.variantName] = await createPresignedGetUrl({
            bucket: env.S3_PRIVATE_BUCKET,
            key: v.s3Key,
            ttlSeconds: env.PRESIGNED_GET_TTL_SECONDS,
          });
        }
      }

      return reply.status(200).send({
        file_id: fileId,
        tier,
        urls,
        location_id: locationId ?? null,
        created_at: new Date().toISOString(),
      });
    },
  );
}
