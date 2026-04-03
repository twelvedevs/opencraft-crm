import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('sharp', () => {
  const mockSharp = vi.fn();
  return { default: mockSharp };
});

vi.mock('../../../src/services/s3.js', () => ({
  uploadToS3: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/lib/s3-key.js', () => ({
  deriveVariantKey: vi.fn((baseKey: string, variant: string) => {
    const lastDot = baseKey.lastIndexOf('.');
    if (lastDot === -1) return `${baseKey}-${variant}.webp`;
    return `${baseKey.substring(0, lastDot)}-${variant}.webp`;
  }),
}));

vi.mock('@ortho/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import sharp from 'sharp';
import { uploadToS3 } from '../../../src/services/s3.js';
import { processImage, isImageMimeType } from '../../../src/services/image-processor.js';

const mockSharp = sharp as unknown as ReturnType<typeof vi.fn>;

function setupSharpMock(buffer?: Buffer) {
  const outputBuffer = buffer ?? Buffer.from('webp-data');
  const chain = {
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(outputBuffer),
    metadata: vi.fn().mockResolvedValue({ width: 1200, height: 800 }),
  };
  mockSharp.mockReturnValue(chain);
  return chain;
}

describe('image-processor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('processImage', () => {
    it('generates medium (800px) and thumb (200px) variants with correct WebP quality', async () => {
      const chain = setupSharpMock();
      const input = Buffer.from('fake-image');

      const result = await processImage(input, 'uploads/abc.png', 'test-bucket');

      expect(result.variants).toHaveLength(2);

      // medium variant
      expect(result.variants[0]).toEqual({
        variantName: 'medium',
        s3Key: 'uploads/abc-medium.webp',
        widthPx: 800,
        sizeBytes: Buffer.from('webp-data').length,
      });

      // thumb variant
      expect(result.variants[1]).toEqual({
        variantName: 'thumb',
        s3Key: 'uploads/abc-thumb.webp',
        widthPx: 200,
        sizeBytes: Buffer.from('webp-data').length,
      });

      // Verify sharp was called with correct resize and quality params
      expect(chain.resize).toHaveBeenCalledWith(800, undefined, { withoutEnlargement: true });
      expect(chain.resize).toHaveBeenCalledWith(200, undefined, { withoutEnlargement: true });
      expect(chain.webp).toHaveBeenCalledWith({ quality: 85 });
      expect(chain.webp).toHaveBeenCalledWith({ quality: 80 });

      // Verify both variants uploaded to S3
      expect(uploadToS3).toHaveBeenCalledTimes(2);
      expect(uploadToS3).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'test-bucket',
          key: 'uploads/abc-medium.webp',
          contentType: 'image/webp',
        }),
      );
      expect(uploadToS3).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'test-bucket',
          key: 'uploads/abc-thumb.webp',
          contentType: 'image/webp',
        }),
      );
    });

    it('returns empty variants array when sharp throws (corrupt file)', async () => {
      mockSharp.mockReturnValue({
        resize: vi.fn().mockReturnThis(),
        webp: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockRejectedValue(new Error('Input buffer contains unsupported image format')),
      });

      const result = await processImage(Buffer.from('corrupt'), 'uploads/bad.png', 'test-bucket');

      expect(result.variants).toEqual([]);
      // Should not throw
    });
  });

  describe('isImageMimeType', () => {
    it('returns true for supported image types', () => {
      expect(isImageMimeType('image/jpeg')).toBe(true);
      expect(isImageMimeType('image/png')).toBe(true);
      expect(isImageMimeType('image/gif')).toBe(true);
      expect(isImageMimeType('image/webp')).toBe(true);
    });

    it('returns false for non-image types', () => {
      expect(isImageMimeType('application/pdf')).toBe(false);
      expect(isImageMimeType('text/plain')).toBe(false);
      expect(isImageMimeType('video/mp4')).toBe(false);
      expect(isImageMimeType('image/svg+xml')).toBe(false);
    });
  });
});
