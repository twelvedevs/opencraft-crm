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

function authHeader(overrides: Record<string, unknown> = {}): string {
  return `Bearer ${signTestToken({
    sub: TEST_USER_ID,
    role: 'marketing_manager',
    locations: [TEST_LOCATION_ID],
    must_change_password: false,
    ...overrides,
  })}`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
let pool: pg.Pool;
let knex: Knex;
let app: FastifyInstance;

describe.skipIf(!process.env['DATABASE_URL'])('upload routes integration', () => {
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
  // POST /media/upload-url
  // =========================================================================
  describe('POST /media/upload-url', () => {
    it('creates DB records and returns upload_id + presigned URL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/media/upload-url',
        headers: { authorization: authHeader() },
        payload: {
          filename: 'photo.png',
          mime_type: 'image/png',
          tier: 'public',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.upload_id).toBeDefined();
      expect(body.upload_url).toBe('https://s3.test.com/presigned-put');
      expect(body.expires_at).toBeDefined();

      // Verify DB records
      const fileRow = await pool.query(
        'SELECT * FROM platform_media.media_files WHERE upload_id = $1',
        [body.upload_id],
      );
      expect(fileRow.rows).toHaveLength(1);
      expect(fileRow.rows[0].status).toBe('pending');
      expect(fileRow.rows[0].tier).toBe('public');
      expect(fileRow.rows[0].uploaded_by).toBe(TEST_USER_ID);

      const intentRow = await pool.query(
        'SELECT * FROM platform_media.media_upload_intents WHERE id = $1',
        [body.upload_id],
      );
      expect(intentRow.rows).toHaveLength(1);
    });

    it('returns 413 when file_size_bytes exceeds limit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/media/upload-url',
        headers: { authorization: authHeader() },
        payload: {
          filename: 'huge.zip',
          mime_type: 'application/zip',
          tier: 'public',
          file_size_bytes: 999_999_999,
        },
      });

      expect(res.statusCode).toBe(413);
      expect(res.json().error).toMatch(/20MB/);
    });

    it('returns 400 for invalid tier', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/media/upload-url',
        headers: { authorization: authHeader() },
        payload: {
          filename: 'file.txt',
          mime_type: 'text/plain',
          tier: 'secret',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for private tier without location_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/media/upload-url',
        headers: { authorization: authHeader() },
        payload: {
          filename: 'file.txt',
          mime_type: 'text/plain',
          tier: 'private',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/location_id/);
    });
  });

  // =========================================================================
  // POST /media/confirm/:upload_id
  // =========================================================================
  describe('POST /media/confirm/:upload_id', () => {
    async function createUploadIntent(
      opts: { tier?: string; mime_type?: string; location_id?: string } = {},
    ): Promise<{ upload_id: string; file_id: string; original_key: string }> {
      const res = await app.inject({
        method: 'POST',
        url: '/media/upload-url',
        headers: { authorization: authHeader() },
        payload: {
          filename: 'photo.png',
          mime_type: opts.mime_type ?? 'image/png',
          tier: opts.tier ?? 'public',
          ...(opts.location_id ? { location_id: opts.location_id } : {}),
        },
      });

      const body = res.json();
      const fileRow = await pool.query(
        'SELECT id, original_key FROM platform_media.media_files WHERE upload_id = $1',
        [body.upload_id],
      );

      return {
        upload_id: body.upload_id,
        file_id: fileRow.rows[0].id,
        original_key: fileRow.rows[0].original_key,
      };
    }

    it('confirms upload, processes image variants, marks ready, returns URLs', async () => {
      const intent = await createUploadIntent();

      // Simulate client putting the file to S3
      s3Store.set(`test-public/${intent.original_key}`, TEST_PNG);

      const res = await app.inject({
        method: 'POST',
        url: `/media/confirm/${intent.upload_id}`,
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.file_id).toBe(intent.file_id);
      expect(body.tier).toBe('public');
      expect(body.urls.original).toContain('https://cdn.test.com/');
      // Sharp should produce medium and thumb variants
      expect(body.urls.medium).toContain('https://cdn.test.com/');
      expect(body.urls.thumb).toContain('https://cdn.test.com/');

      // Verify DB: file is ready
      const fileRow = await pool.query(
        'SELECT status, file_size_bytes FROM platform_media.media_files WHERE id = $1',
        [intent.file_id],
      );
      expect(fileRow.rows[0].status).toBe('ready');
      expect(Number(fileRow.rows[0].file_size_bytes)).toBeGreaterThan(0);

      // Verify DB: variants created
      const variantRows = await pool.query(
        'SELECT variant FROM platform_media.media_variants WHERE file_id = $1 ORDER BY variant',
        [intent.file_id],
      );
      expect(variantRows.rows).toHaveLength(2);
      expect(variantRows.rows.map((r: { variant: string }) => r.variant).sort()).toEqual([
        'medium',
        'thumb',
      ]);

      // Verify DB: upload intent deleted
      const intentRow = await pool.query(
        'SELECT * FROM platform_media.media_upload_intents WHERE id = $1',
        [intent.upload_id],
      );
      expect(intentRow.rows).toHaveLength(0);
    });

    it('returns 502 when S3 object is missing', async () => {
      const intent = await createUploadIntent();
      // Do NOT put data in s3Store — downloadFromS3 will throw NoSuchKey

      const res = await app.inject({
        method: 'POST',
        url: `/media/confirm/${intent.upload_id}`,
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/storage/i);
    });

    it('returns 403 on sub mismatch', async () => {
      const intent = await createUploadIntent();
      s3Store.set(`test-public/${intent.original_key}`, TEST_PNG);

      const otherUser = authHeader({ sub: '00000000-0000-0000-0000-000000000002' });
      const res = await app.inject({
        method: 'POST',
        url: `/media/confirm/${intent.upload_id}`,
        headers: { authorization: otherUser },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 on double confirm', async () => {
      const intent = await createUploadIntent();
      s3Store.set(`test-public/${intent.original_key}`, TEST_PNG);

      // First confirm succeeds
      const res1 = await app.inject({
        method: 'POST',
        url: `/media/confirm/${intent.upload_id}`,
        headers: { authorization: authHeader() },
      });
      expect(res1.statusCode).toBe(200);

      // Second confirm returns 404
      const res2 = await app.inject({
        method: 'POST',
        url: `/media/confirm/${intent.upload_id}`,
        headers: { authorization: authHeader() },
      });
      expect(res2.statusCode).toBe(404);
    });

    it('returns 404 for unknown upload_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/media/confirm/00000000-0000-0000-0000-999999999999',
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // POST /media/upload (proxy multipart)
  // =========================================================================
  describe('POST /media/upload', () => {
    it('uploads image, processes variants, returns complete file record', async () => {
      const mp = buildMultipart(
        { tier: 'public' },
        {
          fieldName: 'file',
          filename: 'photo.png',
          data: TEST_PNG,
          contentType: 'image/png',
        },
      );

      const res = await app.inject({
        method: 'POST',
        url: '/media/upload',
        headers: {
          authorization: authHeader(),
          'content-type': mp.contentType,
        },
        payload: mp.body,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.file_id).toBeDefined();
      expect(body.tier).toBe('public');
      expect(body.urls.original).toContain('https://cdn.test.com/');
      expect(body.urls.medium).toContain('https://cdn.test.com/');
      expect(body.urls.thumb).toContain('https://cdn.test.com/');

      // Verify DB: file is ready
      const fileRow = await pool.query(
        'SELECT status, file_size_bytes, confirmed_at FROM platform_media.media_files WHERE id = $1',
        [body.file_id],
      );
      expect(fileRow.rows).toHaveLength(1);
      expect(fileRow.rows[0].status).toBe('ready');
      expect(fileRow.rows[0].confirmed_at).not.toBeNull();

      // Verify: original was uploaded to S3
      expect(mockUploadToS3).toHaveBeenCalled();
    });

    it('returns 400 on missing tier', async () => {
      const mp = buildMultipart(
        {},
        {
          fieldName: 'file',
          filename: 'photo.png',
          data: TEST_PNG,
          contentType: 'image/png',
        },
      );

      const res = await app.inject({
        method: 'POST',
        url: '/media/upload',
        headers: {
          authorization: authHeader(),
          'content-type': mp.contentType,
        },
        payload: mp.body,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/tier/);
    });

    it('returns 400 on missing file field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/media/upload',
        headers: {
          authorization: authHeader(),
          'content-type': 'multipart/form-data; boundary=----EmptyBoundary',
        },
        payload: Buffer.from('------EmptyBoundary--\r\n'),
      });

      // Either 400 or multipart parse error
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('handles private tier with location_id', async () => {
      const mp = buildMultipart(
        { tier: 'private', location_id: TEST_LOCATION_ID },
        {
          fieldName: 'file',
          filename: 'doc.pdf',
          data: Buffer.from('%PDF-1.4 test content'),
          contentType: 'application/pdf',
        },
      );

      const res = await app.inject({
        method: 'POST',
        url: '/media/upload',
        headers: {
          authorization: authHeader(),
          'content-type': mp.contentType,
        },
        payload: mp.body,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tier).toBe('private');
      expect(body.location_id).toBe(TEST_LOCATION_ID);
      // Private files use presigned GET URLs
      expect(body.urls.original).toBe('https://s3.test.com/presigned-get');
      // PDF is not an image — no variant URLs
      expect(body.urls.medium).toBeUndefined();
      expect(body.urls.thumb).toBeUndefined();
    });
  });
});
