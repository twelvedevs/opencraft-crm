import type { Knex } from 'knex';
import { createPresignedGetUrl } from './s3.js';
import { env } from '../env.js';
import type { MediaFile } from '../repositories/media-files.js';

export async function issuePrivateGetUrl(
  _knex: Knex,
  file: MediaFile,
): Promise<{ signed_url: string; expires_at: string }> {
  if (file.tier !== 'private') {
    throw Object.assign(new Error('Use CloudFront URL for public files'), {
      statusCode: 400,
    });
  }

  const ttl = env.PRESIGNED_GET_TTL_SECONDS;
  const signed_url = await createPresignedGetUrl({
    bucket: env.S3_PRIVATE_BUCKET,
    key: file.original_key,
    ttlSeconds: ttl,
  });

  const expiresAt = new Date(Date.now() + ttl * 1000);
  return {
    signed_url,
    expires_at: expiresAt.toISOString(),
  };
}
