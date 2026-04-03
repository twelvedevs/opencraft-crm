import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import knexLib from 'knex';
import type { Knex } from 'knex';
import {
  setTestEnv,
  mockJwksFetch,
  warnIfSkipped,
  createSchema,
  truncateTables,
  signTestToken,
  TEST_PNG,
  buildMultipart,
} from './helpers.js';

// ---------------------------------------------------------------------------
// 1. Warn and set env BEFORE any app-level imports
// ---------------------------------------------------------------------------
warnIfSkipped();
setTestEnv();
mockJwksFetch();

// ---------------------------------------------------------------------------
// 2. Mock S3 service (in-memory)
// ---------------------------------------------------------------------------
const {
  s3Store,
  mockUploadToS3,
  mockDownloadFromS3,
  mockPresignedPutUrl,
  mockPresignedGetUrl,
} = vi.hoisted(() => {
  const s3Store = new Map<string, Buffer>();
  return {
    s3Store,
    mockUploadToS3: vi.fn(async (params: { bucket: string; key: string; body: Buffer }) => {
      s3Store.set(`${params.bucket}/${params.key}`, params.body);
    }),
    mockDownloadFromS3: vi.fn(async (params: { bucket: string; key: string }) => {
      const data = s3Store.get(`${params.bucket}/${params.key}`);
      if (!data) {
        const err = new Error('NoSuchKey');
        (err as any).name = 'NoSuchKey';
        throw err;
      }
      return data;
    }),
    mockPresignedPutUrl: vi.fn(async () => 'https://s3.test.com/presigned-put'),
    mockPresignedGetUrl: vi.fn(async () => 'https://s3.test.com/presigned-get'),
  };
});

vi.mock('../../src/services/s3.js', () => ({
  uploadToS3: mockUploadToS3,
  downloadFromS3: mockDownloadFromS3,
  createPresignedPutUrl: mockPresignedPutUrl,
  createPresignedGetUrl: mockPresignedGetUrl,
}));

// ---------------------------------------------------------------------------
// 3. Type imports (after mocks)
// ---------------------------------------------------------------------------
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_LOCATION_ID = '00000000-0000-0000-0000-000000000099';
const OTHER_LOCATION_ID = '00000000-0000-0000-0000-000000000088';

function authHeader(overrides: Record<string, unknown> = {}): string {
  return `Bearer ${signTestToken({
    sub: TEST_USER_ID,
    role: 'marketing_manager',
    locations: [TEST_LOCATION_ID],
    location_id: TEST_LOCATION_ID,
    must_change_password: false,
    ...overrides,
  })}`;
}

// ---------------------------------------------------------------------------
// Helper: create a ready file (public or private) via proxy upload
// ---------------------------------------------------------------------------
async function createReadyFile(
  app: FastifyInstance,
  opts: {
    tier: 'public' | 'private';
    location_id?: string;
    mime_type?: string;
    filename?: string;
    data?: Buffer;
    auth?: string;
  },
): Promise<{ file_id: string }> {
  const mp = buildMultipart(
    {
      tier: opts.tier,
      ...(opts.location_id ? { location_id: opts.location_id } : {}),
    },
    {
      fieldName: 'file',
      filename: opts.filename ?? 'photo.png',
      data: opts.data ?? TEST_PNG,
      contentType: opts.mime_type ?? 'image/png',
    },
  );

  const res = await app.inject({
    method: 'POST',
    url: '/media/upload',
    headers: {
      authorization: opts.auth ?? authHeader(),
      'content-type': mp.contentType,
    },
    payload: mp.body,
  });

  const body = res.json();
  return { file_id: body.file_id };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
let pool: pg.Pool;
let knex: Knex;
let app: FastifyInstance;

describe.skipIf(!process.env['DATABASE_URL'])('file routes integration', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await createSchema(pool);

    knex = knexLib({
      client: 'pg',
      connection: process.env['DATABASE_URL'],
      searchPath: ['platform_media'],
    });

    const { buildApp } = await import('../../src/app.js');
    app = await buildApp(pool, knex);
    await app.ready();
  });

  beforeEach(async () => {
    await truncateTables(pool);
    s3Store.clear();
    vi.clearAllMocks();
    // Re-apply default S3 mock implementations after clearAllMocks
    mockUploadToS3.mockImplementation(async (params: { bucket: string; key: string; body: Buffer }) => {
      s3Store.set(`${params.bucket}/${params.key}`, params.body);
    });
    mockDownloadFromS3.mockImplementation(async (params: { bucket: string; key: string }) => {
      const data = s3Store.get(`${params.bucket}/${params.key}`);
      if (!data) {
        const err = new Error('NoSuchKey');
        (err as any).name = 'NoSuchKey';
        throw err;
      }
      return data;
    });
    mockPresignedPutUrl.mockResolvedValue('https://s3.test.com/presigned-put');
    mockPresignedGetUrl.mockResolvedValue('https://s3.test.com/presigned-get');
  });

  afterAll(async () => {
    await app.close();
    await knex.destroy();
    await pool.end();
  });

  // =========================================================================
  // GET /media/:file_id (public file)
  // =========================================================================
  describe('GET /media/:file_id (public file)', () => {
    it('returns CloudFront URLs including variants', async () => {
      const { file_id } = await createReadyFile(app, { tier: 'public' });

      const res = await app.inject({
        method: 'GET',
        url: `/media/${file_id}`,
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.file_id).toBe(file_id);
      expect(body.tier).toBe('public');
      expect(body.urls.original).toContain('https://cdn.test.com/');
      // Image variants should exist
      expect(body.urls.medium).toContain('https://cdn.test.com/');
      expect(body.urls.thumb).toContain('https://cdn.test.com/');
      expect(body.mime_type).toBe('image/png');
      expect(body.original_filename).toBe('photo.png');
    });

    it('returns 404 for deleted file', async () => {
      const { file_id } = await createReadyFile(app, { tier: 'public' });

      // Soft-delete via DB directly (public files can't be user-deleted)
      await pool.query(
        "UPDATE platform_media.media_files SET deleted_at = now(), status = 'deleted' WHERE id = $1",
        [file_id],
      );

      const res = await app.inject({
        method: 'GET',
        url: `/media/${file_id}`,
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/media/00000000-0000-0000-0000-999999999999',
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // GET /media/:file_id (private file)
  // =========================================================================
  describe('GET /media/:file_id (private file)', () => {
    it('returns presigned S3 GET URLs', async () => {
      const { file_id } = await createReadyFile(app, {
        tier: 'private',
        location_id: TEST_LOCATION_ID,
        filename: 'doc.pdf',
        data: Buffer.from('%PDF-1.4 test content'),
        mime_type: 'application/pdf',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/media/${file_id}`,
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tier).toBe('private');
      // Private files use presigned GET URLs
      expect(body.urls.original).toBe('https://s3.test.com/presigned-get');
    });

    it('returns 403 when JWT location_id does not match', async () => {
      const { file_id } = await createReadyFile(app, {
        tier: 'private',
        location_id: OTHER_LOCATION_ID,
        filename: 'doc.pdf',
        data: Buffer.from('%PDF-1.4 test content'),
        mime_type: 'application/pdf',
        auth: authHeader({ location_id: OTHER_LOCATION_ID }),
      });

      // Now request with a different location_id in JWT
      const res = await app.inject({
        method: 'GET',
        url: `/media/${file_id}`,
        headers: { authorization: authHeader({ location_id: TEST_LOCATION_ID }) },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // DELETE /media/:file_id (private file with location_id)
  // =========================================================================
  describe('DELETE /media/:file_id (private)', () => {
    it('soft-deletes and returns 204', async () => {
      const { file_id } = await createReadyFile(app, {
        tier: 'private',
        location_id: TEST_LOCATION_ID,
        filename: 'doc.pdf',
        data: Buffer.from('%PDF-1.4 test content'),
        mime_type: 'application/pdf',
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/media/${file_id}`,
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(204);

      // Verify it's soft-deleted in DB
      const row = await pool.query(
        'SELECT deleted_at FROM platform_media.media_files WHERE id = $1',
        [file_id],
      );
      expect(row.rows[0].deleted_at).not.toBeNull();
    });

    it('returns 403 when location_id mismatch', async () => {
      const { file_id } = await createReadyFile(app, {
        tier: 'private',
        location_id: OTHER_LOCATION_ID,
        filename: 'doc.pdf',
        data: Buffer.from('%PDF-1.4 test'),
        mime_type: 'application/pdf',
        auth: authHeader({ location_id: OTHER_LOCATION_ID }),
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/media/${file_id}`,
        headers: { authorization: authHeader({ location_id: TEST_LOCATION_ID }) },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // DELETE /media/:file_id (public file)
  // =========================================================================
  describe('DELETE /media/:file_id (public)', () => {
    it('returns 403 for public file', async () => {
      const { file_id } = await createReadyFile(app, { tier: 'public' });

      const res = await app.inject({
        method: 'DELETE',
        url: `/media/${file_id}`,
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
