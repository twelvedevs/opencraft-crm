import sharp from 'sharp';
import { createLogger } from '@ortho/logger';
import { uploadToS3 } from './s3.js';
import { deriveVariantKey } from '../lib/s3-key.js';

const logger = createLogger('platform-media');

export interface ImageProcessResult {
  variants: Array<{
    variantName: 'medium' | 'thumb';
    s3Key: string;
    widthPx: number;
    sizeBytes: number;
  }>;
}

const VARIANT_CONFIGS = [
  { name: 'medium' as const, maxWidth: 800, quality: 85 },
  { name: 'thumb' as const, maxWidth: 200, quality: 80 },
];

export async function processImage(
  input: Buffer,
  originalKey: string,
  bucket: string,
): Promise<ImageProcessResult> {
  try {
    const variants = await Promise.all(
      VARIANT_CONFIGS.map(async (config) => {
        const s3Key = deriveVariantKey(originalKey, config.name);

        const buffer = await sharp(input)
          .resize(config.maxWidth, undefined, { withoutEnlargement: true })
          .webp({ quality: config.quality })
          .toBuffer();

        await uploadToS3({
          bucket,
          key: s3Key,
          body: buffer,
          contentType: 'image/webp',
        });

        return {
          variantName: config.name,
          s3Key,
          widthPx: config.maxWidth,
          sizeBytes: buffer.length,
        };
      }),
    );

    return { variants };
  } catch (err) {
    logger.warn({ err }, 'Image processing failed, returning empty variants');
    return { variants: [] };
  }
}

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function isImageMimeType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(mimeType);
}
