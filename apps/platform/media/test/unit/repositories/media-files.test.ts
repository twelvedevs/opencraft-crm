import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import {
  createPending,
  findByUploadId,
  findById,
  markReady,
  softDelete,
} from '../../../src/repositories/media-files.js';

const makeQueryBuilder = (overrides: Record<string, unknown> = {}) => {
  const qb: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    where: vi.fn().mockReturnThis(),
    whereNull: vi.fn().mockReturnThis(),
    update: vi.fn().mockResolvedValue(1),
    first: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return qb;
};

const makeDb = (qb: Record<string, unknown>): Knex => {
  const db = vi.fn().mockReturnValue(qb) as unknown as Knex;
  (db as unknown as Record<string, unknown>)['fn'] = { now: vi.fn().mockReturnValue('NOW()') };
  return db;
};

describe('media-files repository', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('createPending', () => {
    it('inserts a row with status=pending and returns it', async () => {
      const inserted = {
        id: 'file-1',
        upload_id: 'up-1',
        tier: 'public',
        status: 'pending',
        mime_type: 'image/png',
        original_key: 'up-1/abc.png',
        original_filename: 'photo.png',
        file_size_bytes: null,
        location_id: null,
        purpose: null,
        uploaded_by: 'user-1',
        created_at: new Date(),
        confirmed_at: null,
        deleted_at: null,
      };
      const qb = makeQueryBuilder({
        returning: vi.fn().mockResolvedValue([inserted]),
      });
      const db = makeDb(qb);

      const result = await createPending(db, {
        id: 'file-1',
        upload_id: 'up-1',
        tier: 'public',
        mime_type: 'image/png',
        original_key: 'up-1/abc.png',
        original_filename: 'photo.png',
        uploaded_by: 'user-1',
      });

      expect(db).toHaveBeenCalledWith('platform_media.media_files');
      expect(qb.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'file-1',
          upload_id: 'up-1',
          status: 'pending',
          tier: 'public',
        }),
      );
      expect(qb.returning).toHaveBeenCalledWith('*');
      expect(result).toEqual(inserted);
    });
  });

  describe('findByUploadId', () => {
    it('returns the row when found', async () => {
      const row = { id: 'file-1', upload_id: 'up-1' };
      const qb = makeQueryBuilder({
        first: vi.fn().mockResolvedValue(row),
      });
      const db = makeDb(qb);

      const result = await findByUploadId(db, 'up-1');

      expect(qb.where).toHaveBeenCalledWith({ upload_id: 'up-1' });
      expect(result).toEqual(row);
    });

    it('returns null when not found', async () => {
      const qb = makeQueryBuilder({
        first: vi.fn().mockResolvedValue(undefined),
      });
      const db = makeDb(qb);

      const result = await findByUploadId(db, 'nope');
      expect(result).toBeNull();
    });
  });

  describe('findById', () => {
    it('returns row excluding deleted', async () => {
      const row = { id: 'file-1', deleted_at: null };
      const qb = makeQueryBuilder({
        first: vi.fn().mockResolvedValue(row),
      });
      const db = makeDb(qb);

      const result = await findById(db, 'file-1');

      expect(qb.where).toHaveBeenCalledWith({ id: 'file-1' });
      expect(qb.whereNull).toHaveBeenCalledWith('deleted_at');
      expect(result).toEqual(row);
    });

    it('returns null when not found', async () => {
      const qb = makeQueryBuilder({
        first: vi.fn().mockResolvedValue(undefined),
      });
      const db = makeDb(qb);

      const result = await findById(db, 'missing');
      expect(result).toBeNull();
    });
  });

  describe('markReady', () => {
    it('updates status, file_size_bytes, and confirmed_at', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const now = new Date();

      await markReady(db, 'file-1', { file_size_bytes: 12345, confirmed_at: now });

      expect(qb.where).toHaveBeenCalledWith({ id: 'file-1' });
      expect(qb.update).toHaveBeenCalledWith({
        status: 'ready',
        file_size_bytes: 12345,
        confirmed_at: now,
      });
    });
  });

  describe('softDelete', () => {
    it('sets deleted_at to now()', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await softDelete(db, 'file-1');

      expect(qb.where).toHaveBeenCalledWith({ id: 'file-1' });
      expect(qb.update).toHaveBeenCalledWith({ deleted_at: 'NOW()' });
    });
  });
});
