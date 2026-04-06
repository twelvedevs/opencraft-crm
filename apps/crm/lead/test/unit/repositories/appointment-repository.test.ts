import { describe, it, expect, vi } from 'vitest';
import type { Knex } from 'knex';
import {
  createAppointment,
  findById,
  findByLeadId,
  updateAppointment,
  deleteAppointment,
} from '../../../src/repositories/appointment-repository.js';
import type { CreateAppointmentData } from '../../../src/repositories/appointment-repository.js';

const fakeAppointment = {
  id: 'appt-1',
  lead_id: 'lead-1',
  location_id: 'loc-1',
  appointment_type: 'exam',
  scheduled_at: '2026-03-01T10:00:00Z',
  status: 'scheduled',
  notes: null,
  created_by: 'user-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function makeQueryBuilder(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([fakeAppointment]),
    where: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(fakeAppointment),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockResolvedValue(1),
    orderBy: vi.fn().mockReturnThis(),
    then: vi.fn(),
    ...overrides,
  };
  return qb;
}

function makeDb(qb: Record<string, unknown>): Knex {
  const db = vi.fn().mockReturnValue(qb) as unknown as Knex;
  (db as unknown as Record<string, unknown>)['fn'] = {
    now: vi.fn().mockReturnValue('NOW()'),
  };
  return db;
}

describe('appointment-repository', () => {
  describe('createAppointment', () => {
    it('inserts and returns the created appointment', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const data: CreateAppointmentData = {
        lead_id: 'lead-1',
        location_id: 'loc-1',
        appointment_type: 'exam',
        scheduled_at: '2026-03-01T10:00:00Z',
        status: 'scheduled',
        created_by: 'user-1',
      };

      const result = await createAppointment(db, data);

      expect(db).toHaveBeenCalledWith('crm_leads.appointments');
      expect(qb.insert).toHaveBeenCalledWith(data);
      expect(qb.returning).toHaveBeenCalledWith('*');
      expect(result).toEqual(fakeAppointment);
    });
  });

  describe('findById', () => {
    it('returns appointment when found', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      const result = await findById(db, 'appt-1');

      expect(qb.where).toHaveBeenCalledWith({ id: 'appt-1' });
      expect(result).toEqual(fakeAppointment);
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

  describe('findByLeadId', () => {
    it('filters by lead_id and orders by scheduled_at ASC', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([fakeAppointment]))),
      });
      const db = makeDb(qb);

      const result = await findByLeadId(db, 'lead-1');

      expect(qb.where).toHaveBeenCalledWith({ lead_id: 'lead-1' });
      expect(qb.orderBy).toHaveBeenCalledWith('scheduled_at', 'asc');
      expect(result).toEqual([fakeAppointment]);
    });
  });

  describe('updateAppointment', () => {
    it('updates fields and sets updated_at', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      const result = await updateAppointment(db, 'appt-1', { status: 'completed' });

      expect(qb.where).toHaveBeenCalledWith({ id: 'appt-1' });
      expect(qb.update).toHaveBeenCalledWith({ status: 'completed', updated_at: 'NOW()' });
      expect(qb.returning).toHaveBeenCalledWith('*');
      expect(result).toEqual(fakeAppointment);
    });
  });

  describe('deleteAppointment', () => {
    it('deletes by id', async () => {
      const qb = makeQueryBuilder({
        delete: vi.fn().mockReturnThis(),
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb(undefined))),
      });
      const db = makeDb(qb);

      await deleteAppointment(db, 'appt-1');

      expect(qb.where).toHaveBeenCalledWith({ id: 'appt-1' });
      expect(qb.delete).toHaveBeenCalled();
    });
  });
});
