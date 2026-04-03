import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';

const s3 = new S3Client({ region: env.AWS_REGION });

export async function uploadToS3(params: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
}): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      ...(params.cacheControl ? { CacheControl: params.cacheControl } : {}),
    }),
  );
}

export async function downloadFromS3(params: {
  bucket: string;
  key: string;
}): Promise<Buffer> {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
    }),
  );
  const bytes = await response.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function createPresignedPutUrl(params: {
  bucket: string;
  key: string;
  contentType: string;
  ttlSeconds: number;
  maxSizeBytes: number;
}): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    ContentType: params.contentType,
  });
  return getSignedUrl(s3, command, { expiresIn: params.ttlSeconds });
}

export async function createPresignedGetUrl(params: {
  bucket: string;
  key: string;
  ttlSeconds: number;
}): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
  });
  return getSignedUrl(s3, command, { expiresIn: params.ttlSeconds });
}
