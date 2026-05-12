import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportService, ImportServiceError } from '../../src/services/import.service.js';
import type { ImportRepository } from '../../src/repositories/import.repo.js';
import type { ImportRowRepository } from '../../src/repositories/import-row.repo.js';
import type { ColumnMappingRepository } from '../../src/repositories/column-mapping.repo.js';
import type { Import } from '../../src/types.js';
import type { Knex } from 'knex';

function makeImport(overrides: Partial<Import> = {}): Import {
  return {
    id: crypto.randomUUID(),
    location_id: crypto.randomUUID(),
    import_type: 'active_patients',
    status: 'preview_ready',
    uploaded_by: crypto.randomUUID(),
    file_name: 'test.csv',
    file_key: 'imports/test/raw.csv',
    column_mapping: null,
    detected_headers: null,
    row_count: null,
    matched_count: null,
    unmatched_count: null,
    ambiguous_count: null,
    executed_count: null,
    failed_count: null,
    error_message: null,
    completed_at: null,
    undo_deadline: null,
    undone_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function mockImportRepo(findByIdReturn?: Import) {
  return {
    create: vi.fn().mockImplementation(async (data: Partial<Import>) => ({
      ...makeImport(),
      ...data,
    })),
    findById: vi.fn().mockResolvedValue(findByIdReturn),
    update: vi.fn().mockImplementation(async (id: string, fields: Partial<Import>) => ({
      ...findByIdReturn,
      ...fields,
      id,
    })),
    listByLocation: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
  } as unknown as ImportRepository;
}

function mockImportRowRepo() {
  return {
    batchInsert: vi.fn(),
    findByImportId: vi.fn(),
    update: vi.fn(),
    findMatchedByImportId: vi.fn(),
    findExecutedByImportIdDesc: vi.fn(),
    findByImportIdAndStatus: vi.fn(),
  } as unknown as ImportRowRepository;
}

function mockColumnMappingRepo() {
  return {
    findByType: vi.fn(),
    upsert: vi.fn().mockResolvedValue({}),
  } as unknown as ColumnMappingRepository;
}

describe('ImportService', () => {
  let importRepo: ImportRepository;
  let importRowRepo: ImportRowRepository;
  let columnMappingRepo: ColumnMappingRepository;
  let db: Knex;
  let service: ImportService;

  describe('confirmImport', () => {
    it('throws 409 when status is not preview_ready', async () => {
      const record = makeImport({ status: 'uploading' });
      importRepo = mockImportRepo(record);
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      db = {} as Knex;
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      try {
        await service.confirmImport(record.id, { first_name: 'PatFirst' }, 'user-1');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ImportServiceError);
        expect((err as ImportServiceError).statusCode).toBe(409);
      }
    });

    it('succeeds when status is preview_ready', async () => {
      const record = makeImport({ status: 'preview_ready' });
      importRepo = mockImportRepo(record);
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      db = {} as Knex;
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      await service.confirmImport(record.id, { first_name: 'PatFirst' }, 'user-1');

      expect(vi.mocked(columnMappingRepo.upsert)).toHaveBeenCalledWith(
        record.import_type,
        { first_name: 'PatFirst' },
        'user-1',
      );
      expect(vi.mocked(importRepo.update)).toHaveBeenCalledWith(record.id, {
        column_mapping: { first_name: 'PatFirst' },
      });
    });

    it('throws 409 on completed status', async () => {
      const record = makeImport({ status: 'completed' });
      importRepo = mockImportRepo(record);
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      db = {} as Knex;
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      try {
        await service.confirmImport(record.id, {}, 'user-1');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ImportServiceError);
        expect((err as ImportServiceError).statusCode).toBe(409);
      }
    });
  });

  describe('cancelImport', () => {
    it('throws 409 when status is not preview_ready', async () => {
      const record = makeImport({ status: 'completed' });
      importRepo = mockImportRepo(record);
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      db = {} as Knex;
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      try {
        await service.cancelImport(record.id);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ImportServiceError);
        expect((err as ImportServiceError).statusCode).toBe(409);
      }
    });

    it('throws 409 on uploading status', async () => {
      const record = makeImport({ status: 'uploading' });
      importRepo = mockImportRepo(record);
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      db = {} as Knex;
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      try {
        await service.cancelImport(record.id);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ImportServiceError);
        expect((err as ImportServiceError).statusCode).toBe(409);
      }
    });

    it('succeeds when status is preview_ready', async () => {
      const record = makeImport({ status: 'preview_ready' });
      importRepo = mockImportRepo(record);
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      db = {} as Knex;
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      await service.cancelImport(record.id);

      expect(vi.mocked(importRepo.update)).toHaveBeenCalledWith(record.id, {
        status: 'cancelled',
      });
    });
  });

  describe('initiateUndo', () => {
    it('throws 422 with undo_window_expired when deadline is past', async () => {
      const pastDeadline = new Date(Date.now() - 60_000);
      const rawFn = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ status: 'completed', undo_deadline: pastDeadline }],
        });

      db = { raw: rawFn } as unknown as Knex;
      importRepo = mockImportRepo();
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      try {
        await service.initiateUndo('some-id');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ImportServiceError);
        expect((err as ImportServiceError).statusCode).toBe(422);
        expect((err as ImportServiceError).body).toEqual({ error: 'undo_window_expired' });
      }
    });

    it('throws 409 when status is undoing', async () => {
      const futureDeadline = new Date(Date.now() + 3_600_000);
      const rawFn = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ status: 'undoing', undo_deadline: futureDeadline }],
        });

      db = { raw: rawFn } as unknown as Knex;
      importRepo = mockImportRepo();
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      try {
        await service.initiateUndo('some-id');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ImportServiceError);
        expect((err as ImportServiceError).statusCode).toBe(409);
      }
    });

    it('throws 404 when import not found', async () => {
      const rawFn = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      db = { raw: rawFn } as unknown as Knex;
      importRepo = mockImportRepo();
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      try {
        await service.initiateUndo('nonexistent');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ImportServiceError);
        expect((err as ImportServiceError).statusCode).toBe(404);
      }
    });

    it('returns the updated import on success', async () => {
      const importRecord = makeImport({ status: 'undoing' });
      const rawFn = vi.fn()
        .mockResolvedValueOnce({ rows: [importRecord] });

      db = { raw: rawFn } as unknown as Knex;
      importRepo = mockImportRepo();
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      const result = await service.initiateUndo('some-id');
      expect(result).toEqual(importRecord);
    });

    it('raw SQL contains now() for atomic undo_deadline check', async () => {
      const importRecord = makeImport({ status: 'undoing' });
      const rawFn = vi.fn()
        .mockResolvedValueOnce({ rows: [importRecord] });

      db = { raw: rawFn } as unknown as Knex;
      importRepo = mockImportRepo();
      importRowRepo = mockImportRowRepo();
      columnMappingRepo = mockColumnMappingRepo();
      service = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

      await service.initiateUndo('some-id');

      const sql = rawFn.mock.calls[0][0] as string;
      expect(sql).toContain('now()');
      expect(sql).toContain('undo_deadline');
      expect(sql).toContain("status = 'undoing'");
    });
  });
});
