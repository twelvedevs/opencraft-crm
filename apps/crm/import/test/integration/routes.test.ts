import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Knex } from 'knex';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { authPlugin } from '@ortho/auth-middleware';
import { createLogger } from '@ortho/logger';
import type { Queue } from 'bullmq';
import {
  HAS_DB,
  getDb,
  runMigrations,
  cleanup,
  truncateTables,
  makeJwt,
  mockFetchForJwks,
  restoreFetch,
  LOCATION_ID,
  USER_ID,
  LEAD_ID_1,
} from './helpers.js';
import { ImportRepository } from '../../src/repositories/import.repo.js';
import { ImportRowRepository } from '../../src/repositories/import-row.repo.js';
import { ColumnMappingRepository } from '../../src/repositories/column-mapping.repo.js';
import { ImportService } from '../../src/services/import.service.js';
import { mappingsRoutes } from '../../src/routes/mappings.js';
import { importsRoutes } from '../../src/routes/imports.js';
import { rowsRoutes } from '../../src/routes/rows.js';
import { actionsRoutes } from '../../src/routes/actions.js';
import type { ImportJobData } from '../../src/workers/import-job.js';

// ─── Mock @aws-sdk/lib-storage Upload ────────────────────────────────────────

const { MockUpload, mockUploadDone } = vi.hoisted(() => {
  const mockUploadDone = vi.fn().mockResolvedValue(undefined);
  const MockUpload = vi.fn().mockImplementation(() => ({
    done: mockUploadDone,
  }));
  return { MockUpload, mockUploadDone };
});

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: MockUpload,
}));

// ─── Shared mocks ────────────────────────────────────────────────────────────

const mockQueueAdd = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockQueue = { add: mockQueueAdd } as unknown as Queue<ImportJobData>;
const mockS3Client = {} as unknown as import('@aws-sdk/client-s3').S3Client;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildMultipartPayload(
  fields: Record<string, string>,
  file: { name: string; filename: string; content: string },
) {
  const boundary = '----TestFormBoundary';
  const parts: string[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`,
    );
  }

  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: text/csv\r\n\r\n${file.content}`,
  );
  parts.push(`--${boundary}--`);

  return {
    body: parts.join('\r\n'),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('routes (integration)', () => {
  let db: Knex;
  let app: FastifyInstance;
  let managerToken: string;

  beforeAll(async () => {
    mockFetchForJwks();
    await runMigrations();
    db = getDb();

    const importRepo = new ImportRepository(db);
    const importRowRepo = new ImportRowRepository(db);
    const columnMappingRepo = new ColumnMappingRepository(db);
    const importService = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

    const log = createLogger('crm-import-test');
    app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

    await app.register(sensible);
    await app.register(multipart);

    await app.register(async (scope) => {
      await scope.register(authPlugin, {
        jwksUrl: 'http://localhost:9999/.well-known/jwks.json',
      });

      // mappings first — prevent 'column-mappings' matching :id
      await scope.register(mappingsRoutes({ columnMappingRepo }));
      await scope.register(importsRoutes({ importService, s3Client: mockS3Client, importQueue: mockQueue }));
      await scope.register(rowsRoutes({ importService, importRowRepo }));
      await scope.register(actionsRoutes({ importService, importQueue: mockQueue }));
    });

    await app.ready();

    managerToken = makeJwt({
      sub: USER_ID,
      role: 'call_center_manager',
      locations: [LOCATION_ID],
    });
  });

  afterAll(async () => {
    await app.close();
    restoreFetch();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    mockQueueAdd.mockClear();
    MockUpload.mockClear();
    mockUploadDone.mockClear();
  });

  // ─── Seed helpers ────────────────────────────────────────────────

  async function seedImport(overrides: Record<string, unknown> = {}) {
    const importId = crypto.randomUUID();
    await db('crm_imports.imports').insert({
      id: importId,
      location_id: LOCATION_ID,
      import_type: 'active_patients',
      status: 'uploading',
      uploaded_by: USER_ID,
      file_name: 'test.csv',
      file_key: `imports/${importId}/raw.csv`,
      ...overrides,
    });
    return importId;
  }

  async function seedImportRow(
    importId: string,
    rowNumber: number,
    overrides: Record<string, unknown> = {},
  ) {
    const rowId = crypto.randomUUID();
    await db('crm_imports.import_rows').insert({
      id: rowId,
      import_id: importId,
      row_number: rowNumber,
      raw_data: JSON.stringify({ PatFirst: 'Test', PatLast: 'User' }),
      status: 'matched',
      ...overrides,
    });
    return rowId;
  }

  // ─── POST /imports ──────────────────────────────────────────────

  it('POST /imports: streams to S3, creates import, enqueues parse_match job, returns 201', async () => {
    const csvContent = 'PatFirst,PatLast,CellPhone\nJohn,Doe,+12125551234';
    const { body, contentType } = buildMultipartPayload(
      { import_type: 'active_patients', location_id: LOCATION_ID },
      { name: 'file', filename: 'test.csv', content: csvContent },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/imports',
      headers: {
        authorization: `Bearer ${managerToken}`,
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const record = res.json();
    expect(record.id).toBeDefined();
    expect(record.status).toBe('uploading');
    expect(record.import_type).toBe('active_patients');
    expect(record.location_id).toBe(LOCATION_ID);

    // Upload mock invoked with correct S3 key
    expect(MockUpload).toHaveBeenCalledTimes(1);
    const uploadOpts = MockUpload.mock.calls[0][0] as { params: { Key: string } };
    expect(uploadOpts.params.Key).toBe(`imports/${record.id}/raw.csv`);

    // Import record exists in DB with status='uploading'
    const dbRecord = await db('crm_imports.imports').where({ id: record.id }).first();
    expect(dbRecord).toBeDefined();
    expect(dbRecord.status).toBe('uploading');

    // BullMQ job enqueued
    expect(mockQueueAdd).toHaveBeenCalledWith('import-job', {
      import_id: record.id,
      phase: 'parse_match',
    });
  });

  // ─── POST /imports/:id/confirm ─────────────────────────────────

  it('POST /imports/:id/confirm: upserts column_mapping, enqueues execute job, returns 202; second confirm returns 409', async () => {
    const importId = await seedImport({ status: 'preview_ready' });
    const columnMapping = { first_name: 'PatFirst', last_name: 'PatLast' };

    const res = await app.inject({
      method: 'POST',
      url: `/imports/${importId}/confirm`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { column_mapping: columnMapping },
    });

    expect(res.statusCode).toBe(202);
    const record = res.json();
    expect(record.column_mapping).toEqual(columnMapping);

    // column_mappings row upserted
    const mappingRow = await db('crm_imports.column_mappings')
      .where({ import_type: 'active_patients' })
      .first();
    expect(mappingRow).toBeDefined();
    expect(mappingRow.mapping).toEqual(columnMapping);

    // BullMQ job enqueued with execute phase
    expect(mockQueueAdd).toHaveBeenCalledWith('import-job', {
      import_id: importId,
      phase: 'execute',
    });

    // Second confirm → 409
    mockQueueAdd.mockClear();
    const res2 = await app.inject({
      method: 'POST',
      url: `/imports/${importId}/confirm`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { column_mapping: columnMapping },
    });

    expect(res2.statusCode).toBe(409);
    // No job enqueued for failed confirm
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  // ─── POST /imports/:id/cancel ──────────────────────────────────

  it('POST /imports/:id/cancel: preview_ready → 200 cancelled; non-preview_ready → 409', async () => {
    const importId = await seedImport({ status: 'preview_ready' });

    const res = await app.inject({
      method: 'POST',
      url: `/imports/${importId}/cancel`,
      headers: { authorization: `Bearer ${managerToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');

    // Cancelling again (now 'cancelled' status) → 409
    const res2 = await app.inject({
      method: 'POST',
      url: `/imports/${importId}/cancel`,
      headers: { authorization: `Bearer ${managerToken}` },
    });

    expect(res2.statusCode).toBe(409);
  });

  // ─── GET /imports/:id/rows — pagination ────────────────────────

  it('GET /imports/:id/rows: pagination with limit=3, cursor navigation, and status filter', async () => {
    const importId = await seedImport({ status: 'preview_ready' });

    // Seed 10 rows: 7 matched, 3 unmatched
    for (let i = 1; i <= 7; i++) {
      await seedImportRow(importId, i, { status: 'matched' });
    }
    for (let i = 8; i <= 10; i++) {
      await seedImportRow(importId, i, { status: 'unmatched' });
    }

    // First page: limit=3, no cursor → rows 1,2,3, nextCursor=3
    const res1 = await app.inject({
      method: 'GET',
      url: `/imports/${importId}/rows?limit=3`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res1.statusCode).toBe(200);
    const page1 = res1.json();
    expect(page1.data).toHaveLength(3);
    expect(page1.data[0].row_number).toBe(1);
    expect(page1.data[2].row_number).toBe(3);
    expect(page1.nextCursor).toBe(3);

    // Second page: cursor=3 → rows 4,5,6, nextCursor=6
    const res2 = await app.inject({
      method: 'GET',
      url: `/imports/${importId}/rows?limit=3&cursor=${page1.nextCursor}`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res2.statusCode).toBe(200);
    const page2 = res2.json();
    expect(page2.data).toHaveLength(3);
    expect(page2.data[0].row_number).toBe(4);
    expect(page2.nextCursor).toBe(6);

    // Last page: cursor=9 → row 10, nextCursor=null
    const res3 = await app.inject({
      method: 'GET',
      url: `/imports/${importId}/rows?limit=3&cursor=9`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res3.statusCode).toBe(200);
    const page3 = res3.json();
    expect(page3.data).toHaveLength(1);
    expect(page3.data[0].row_number).toBe(10);
    expect(page3.nextCursor).toBeNull();

    // Status filter: only unmatched rows
    const res4 = await app.inject({
      method: 'GET',
      url: `/imports/${importId}/rows?status=unmatched`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res4.statusCode).toBe(200);
    const filtered = res4.json();
    expect(filtered.data).toHaveLength(3);
    for (const row of filtered.data) {
      expect(row.status).toBe('unmatched');
    }
  });

  // ─── GET /imports/column-mappings/:type ────────────────────────

  it('GET /imports/column-mappings/:type: returns saved mapping; 404 if none saved', async () => {
    // 404 when no mapping exists
    const res1 = await app.inject({
      method: 'GET',
      url: '/imports/column-mappings/active_patients',
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res1.statusCode).toBe(404);

    // Seed a mapping
    await db('crm_imports.column_mappings').insert({
      import_type: 'active_patients',
      mapping: JSON.stringify({ first_name: 'PatFirst', last_name: 'PatLast' }),
      updated_at: new Date(),
      updated_by: USER_ID,
    });

    // Now returns the mapping
    const res2 = await app.inject({
      method: 'GET',
      url: '/imports/column-mappings/active_patients',
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res2.statusCode).toBe(200);
    const body = res2.json();
    expect(body.import_type).toBe('active_patients');
    expect(body.mapping).toEqual({ first_name: 'PatFirst', last_name: 'PatLast' });
    expect(body.updated_by).toBe(USER_ID);
  });
});
