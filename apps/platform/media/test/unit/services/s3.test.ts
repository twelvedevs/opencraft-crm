import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, mockGetSignedUrl } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com'),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: vi.fn().mockImplementation((params) => ({ ...params, _type: 'PutObject' })),
  GetObjectCommand: vi.fn().mockImplementation((params) => ({ ...params, _type: 'GetObject' })),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock('../../../src/env.js', () => ({
  env: {
    AWS_REGION: 'us-east-1',
  },
}));

import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  uploadToS3,
  downloadFromS3,
  createPresignedPutUrl,
  createPresignedGetUrl,
} from '../../../src/services/s3.js';

describe('s3 service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSend.mockReset();
    mockGetSignedUrl.mockReset().mockResolvedValue('https://signed-url.example.com');
  });

  describe('uploadToS3', () => {
    it('constructs PutObjectCommand with correct Bucket/Key/Body/ContentType', async () => {
      mockSend.mockResolvedValue({});
      const body = Buffer.from('file-data');

      await uploadToS3({
        bucket: 'my-bucket',
        key: 'path/to/file.png',
        body,
        contentType: 'image/png',
      });

      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
        Key: 'path/to/file.png',
        Body: body,
        ContentType: 'image/png',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('includes CacheControl when provided', async () => {
      mockSend.mockResolvedValue({});

      await uploadToS3({
        bucket: 'my-bucket',
        key: 'path/to/file.png',
        body: Buffer.from('data'),
        contentType: 'image/png',
        cacheControl: 'max-age=31536000',
      });

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ CacheControl: 'max-age=31536000' }),
      );
    });
  });

  describe('downloadFromS3', () => {
    it('returns buffer from S3 response body', async () => {
      const bodyBytes = new Uint8Array([1, 2, 3, 4]);
      mockSend.mockResolvedValue({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(bodyBytes),
        },
      });

      const result = await downloadFromS3({ bucket: 'my-bucket', key: 'file.png' });

      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
        Key: 'file.png',
      });
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(Buffer.from(bodyBytes));
    });
  });

  describe('createPresignedPutUrl', () => {
    it('calls getSignedUrl with correct TTL', async () => {
      const url = await createPresignedPutUrl({
        bucket: 'my-bucket',
        key: 'path/file.png',
        contentType: 'image/png',
        ttlSeconds: 900,
        maxSizeBytes: 20971520,
      });

      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
        Key: 'path/file.png',
        ContentType: 'image/png',
      });
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 900 },
      );
      expect(url).toBe('https://signed-url.example.com');
    });
  });

  describe('createPresignedGetUrl', () => {
    it('calls getSignedUrl with correct TTL', async () => {
      const url = await createPresignedGetUrl({
        bucket: 'my-bucket',
        key: 'path/file.png',
        ttlSeconds: 300,
      });

      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
        Key: 'path/file.png',
      });
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 300 },
      );
      expect(url).toBe('https://signed-url.example.com');
    });
  });
});
