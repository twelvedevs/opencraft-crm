import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/s3.js', () => ({
  createPresignedGetUrl: vi.fn().mockResolvedValue('https://signed.example.com/private-file'),
}));

vi.mock('../../../src/env.js', () => ({
  env: {
    S3_PRIVATE_BUCKET: 'test-private-bucket',
    PRESIGNED_GET_TTL_SECONDS: 900,
  },
}));

import { createPresignedGetUrl } from '../../../src/services/s3.js';
import { issuePrivateGetUrl } from '../../../src/services/signed-url.js';
import type { MediaFile } from '../../../src/repositories/media-files.js';
import type { Knex } from 'knex';

const mockKnex = {} as Knex;

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    id: 'file-1',
    upload_id: 'up-1',
    tier: 'private',
    status: 'ready',
    mime_type: 'application/pdf',
    original_key: 'loc-1/up-1/abc.pdf',
    original_filename: 'report.pdf',
    file_size_bytes: '1024',
    location_id: 'loc-1',
    purpose: null,
    uploaded_by: 'user-1',
    created_at: new Date(),
    confirmed_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

describe('signed-url service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (createPresignedGetUrl as ReturnType<typeof vi.fn>).mockResolvedValue(
      'https://signed.example.com/private-file',
    );
  });

  it('returns signed_url and expires_at for private file', async () => {
    const file = makeFile();
    const result = await issuePrivateGetUrl(mockKnex, file);

    expect(result).toHaveProperty('signed_url', 'https://signed.example.com/private-file');
    expect(result).toHaveProperty('expires_at');
    // expires_at should be an ISO 8601 string
    expect(new Date(result.expires_at).toISOString()).toBe(result.expires_at);

    expect(createPresignedGetUrl).toHaveBeenCalledWith({
      bucket: 'test-private-bucket',
      key: 'loc-1/up-1/abc.pdf',
      ttlSeconds: 900,
    });
  });

  it('throws 400 error when called with a public-tier file', async () => {
    const publicFile = makeFile({ tier: 'public' });

    await expect(issuePrivateGetUrl(mockKnex, publicFile)).rejects.toMatchObject({
      message: 'Use CloudFront URL for public files',
      statusCode: 400,
    });
  });
});
