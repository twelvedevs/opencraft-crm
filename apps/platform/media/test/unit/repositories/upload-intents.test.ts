import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import {
  createIntent,
  findByUploadId,
  deleteExpired,
} from '../../../src/repositories/upload-intents.js';

const makeQueryBuilder = (overrides: Record<string, unknown> = {}) => {
  const qb: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    where: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
  return qb;
};

const makeDb = (qb: Record<string, unknown>): Knex => {
  const db = vi.fn().mockReturnValue(qb) as unknown as Knex;
  (db as unknown as Record<string, unknown>)['fn'] = { now: vi.fn().mockReturnValue('NOW()') };
  return db;
};

describe('upload-intents repository', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('createIntent', () => {
    it('inserts and returns the intent row', async () => {
      const intent = {
        id: 'up-1',
        file_id: 'file-1',
        presigned_url: 'https://s3.example.com/put',
        expires_at: new Date('2026-04-03T12:00:00Z'),
        created_at: new Date(),
      };
      const qb = makeQueryBuilder({
        returning: vi.fn().mockResolvedValue([intent]),
      });
      const db = makeDb(qb);

      const result = await createIntent(db, {
        id: 'up-1',
        file_id: 'file-1',
        presigned_url: 'https://s3.example.com/put',
        expires_at: new Date('2026-04-03T12:00:00Z'),
      });

      expect(db).toHaveBeenCalledWith('platform_media.media_upload_intents');
      expect(qb.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'up-1',
          file_id: 'file-1',
        }),
      );
      expect(qb.returning).toHaveBeenCalledWith('*');
      expect(result).toEqual(intent);
    });
  });

  describe('findByUploadId', () => {
    it('returns intent when found', async () => {
      const intent = { id: 'up-1', file_id: 'file-1' };
      const qb = makeQueryBuilder({
        first: vi.fn().mockResolvedValue(intent),
      });
      const db = makeDb(qb);

      const result = await findByUploadId(db, 'up-1');

      expect(qb.where).toHaveBeenCalledWith({ id: 'up-1' });
      expect(result).toEqual(intent);
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

  describe('deleteExpired', () => {
    it('deletes rows where expires_at < now() and returns count', async () => {
      const qb = makeQueryBuilder({
        del: vi.fn().mockResolvedValue(3),
      });
      const db = makeDb(qb);

      const count = await deleteExpired(db);

      expect(qb.where).toHaveBeenCalledWith('expires_at', '<', 'NOW()');
      expect(count).toBe(3);
    });
  });
});
