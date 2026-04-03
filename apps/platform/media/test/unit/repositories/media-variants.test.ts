import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import {
  insertVariant,
  findByFileId,
} from '../../../src/repositories/media-variants.js';

const makeQueryBuilder = (overrides: Record<string, unknown> = {}) => {
  const qb: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    onConflict: vi.fn().mockReturnThis(),
    ignore: vi.fn().mockResolvedValue(undefined),
    where: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  return qb;
};

const makeDb = (qb: Record<string, unknown>): Knex => {
  return vi.fn().mockReturnValue(qb) as unknown as Knex;
};

describe('media-variants repository', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('insertVariant', () => {
    it('inserts a variant with ON CONFLICT DO NOTHING', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await insertVariant(db, {
        file_id: 'file-1',
        variant: 'medium',
        s3_key: 'abc/def-medium.webp',
        width_px: 800,
        size_bytes: 5000,
      });

      expect(db).toHaveBeenCalledWith('platform_media.media_variants');
      expect(qb.insert).toHaveBeenCalledWith({
        file_id: 'file-1',
        variant: 'medium',
        s3_key: 'abc/def-medium.webp',
        width_px: 800,
        size_bytes: 5000,
      });
      expect(qb.onConflict).toHaveBeenCalledWith(['file_id', 'variant']);
      expect(qb.ignore).toHaveBeenCalled();
    });
  });

  describe('findByFileId', () => {
    it('returns array of variants', async () => {
      const rows = [
        { id: 'v1', file_id: 'file-1', variant: 'medium', s3_key: 'k1', width_px: 800, size_bytes: '5000' },
        { id: 'v2', file_id: 'file-1', variant: 'thumb', s3_key: 'k2', width_px: 200, size_bytes: '2000' },
      ];
      const qb = makeQueryBuilder();
      // findByFileId calls knex(TABLE).where({ file_id }) which resolves to rows
      // The where() call is terminal here (returns promise), not chained further
      const db = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }) as unknown as Knex;

      const result = await findByFileId(db, 'file-1');
      expect(result).toEqual(rows);
    });

    it('returns empty array when no variants exist', async () => {
      const db = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }) as unknown as Knex;

      const result = await findByFileId(db, 'file-1');
      expect(result).toEqual([]);
    });
  });
});
