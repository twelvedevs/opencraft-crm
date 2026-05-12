import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SegmentsRepository } from '../../src/repositories/segments.repository.js';

function createMockDb() {
  const mockReturning = vi.fn();
  const mockUpdate = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockWhere = vi.fn().mockReturnValue({ update: mockUpdate, first: vi.fn() });
  const mockInsert = vi.fn().mockReturnValue({ returning: vi.fn() });

  const db = vi.fn().mockReturnValue({
    insert: mockInsert,
    where: mockWhere,
    first: vi.fn(),
  }) as any;

  db.raw = vi.fn();
  db.fn = { now: vi.fn().mockReturnValue('NOW()') };

  return db;
}

describe('Versioning logic', () => {
  describe('SegmentsRepository.updateCurrentVersionFilter', () => {
    it('PUT on segment with active_version IS NULL — version row overwritten, current_version unchanged', async () => {
      const db = createMockDb();
      const mockUpdate = vi.fn().mockResolvedValue(1);
      db.mockReturnValue({
        where: vi.fn().mockReturnValue({
          update: mockUpdate,
        }),
      });
      const repo = new SegmentsRepository(db);

      await repo.updateCurrentVersionFilter('seg-1', 1, { field: 'name', op: 'eq', value: 'test' });

      // DB called with the correct table and filter
      expect(db).toHaveBeenCalledWith('audience_segment_versions');
      expect(mockUpdate).toHaveBeenCalledWith({
        filter: JSON.stringify({ field: 'name', op: 'eq', value: 'test' }),
      });
    });
  });

  describe('SegmentsRepository.incrementVersion + createVersion', () => {
    it('PUT on segment where current_version === active_version — new version created, current_version incremented', async () => {
      const db = createMockDb();

      // incrementVersion: returns new current_version
      const mockReturning = vi.fn().mockResolvedValue([{ current_version: 2 }]);
      const mockUpdateInc = vi.fn().mockReturnValue({ returning: mockReturning });
      const mockWhereInc = vi.fn().mockReturnValue({ update: mockUpdateInc });

      // createVersion: insert into versions table
      const mockInsert = vi.fn().mockResolvedValue(undefined);

      let callCount = 0;
      db.mockImplementation((table: string) => {
        if (table === 'audience_segments') {
          return { where: mockWhereInc };
        }
        if (table === 'audience_segment_versions') {
          return { insert: mockInsert };
        }
        return {};
      });

      const repo = new SegmentsRepository(db);

      // 1. Increment version
      const newVersion = await repo.incrementVersion('seg-1');
      expect(newVersion).toBe(2);
      expect(mockWhereInc).toHaveBeenCalledWith({ id: 'seg-1' });

      // 2. Create new version row
      await repo.createVersion({
        id: 'v-uuid',
        segment_id: 'seg-1',
        version: 2,
        filter: { field: 'city', op: 'eq', value: 'NYC' },
        created_by: null,
      });
      expect(mockInsert).toHaveBeenCalledWith({
        id: 'v-uuid',
        segment_id: 'seg-1',
        version: 2,
        filter: JSON.stringify({ field: 'city', op: 'eq', value: 'NYC' }),
        created_by: null,
      });
    });
  });

  describe('SegmentsRepository.updateStatus — activate', () => {
    it('activate sets active_version = current_version and status = active', async () => {
      const db = createMockDb();
      const mockReturning = vi.fn().mockResolvedValue([{
        id: 'seg-1',
        name: 'Test',
        status: 'active',
        active_version: 1,
        current_version: 1,
        created_by: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      }]);
      const mockUpdate = vi.fn().mockReturnValue({ returning: mockReturning });
      const mockWhere = vi.fn().mockReturnValue({ update: mockUpdate });
      db.mockReturnValue({ where: mockWhere });

      const repo = new SegmentsRepository(db);
      const result = await repo.updateStatus('seg-1', 'active', 1);

      expect(result).not.toBeNull();
      expect(result!.status).toBe('active');
      expect(result!.active_version).toBe(1);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
          active_version: 1,
        }),
      );
    });
  });

  describe('SegmentsRepository.updateStatus — disable', () => {
    it('disable sets status = disabled', async () => {
      const db = createMockDb();
      const mockReturning = vi.fn().mockResolvedValue([{
        id: 'seg-1',
        name: 'Test',
        status: 'disabled',
        active_version: 1,
        current_version: 1,
        created_by: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      }]);
      const mockUpdate = vi.fn().mockReturnValue({ returning: mockReturning });
      const mockWhere = vi.fn().mockReturnValue({ update: mockUpdate });
      db.mockReturnValue({ where: mockWhere });

      const repo = new SegmentsRepository(db);
      const result = await repo.updateStatus('seg-1', 'disabled');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('disabled');
      // active_version should NOT be in the update call
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.not.objectContaining({ active_version: expect.anything() }),
      );
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'disabled' }),
      );
    });
  });
});
