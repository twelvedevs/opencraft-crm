import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/repositories/lead-repository.js', () => ({
  findById: vi.fn(),
}));

vi.mock('../../../src/repositories/appointment-repository.js', () => ({
  createAppointment: vi.fn(),
  findById: vi.fn(),
  findByLeadId: vi.fn(),
  updateAppointment: vi.fn(),
  deleteAppointment: vi.fn(),
}));

import type { Knex } from 'knex';
import {
  createAppointment,
  updateAppointment,
  deleteAppointment,
  listAppointments,
} from '../../../src/services/appointment-service.js';
import * as leadRepository from '../../../src/repositories/lead-repository.js';
import * as appointmentRepository from '../../../src/repositories/appointment-repository.js';

const db = {} as Knex;

const fakeLead = {
  id: 'lead-1',
  location_id: 'loc-1',
  first_name: 'John',
  last_name: 'Doe',
  phone: '+15551234567',
  email: null,
  treatment_interest: null,
  date_of_birth: null,
  channel: 'website_form',
  contact_status: 'active',
  current_pipeline: 'none',
  current_stage: null,
  last_activity_at: null,
  score: 0,
  duplicate_status: 'none',
  duplicate_of_id: null,
  merged_into_id: null,
  archived_at: null,
  first_touch_source: null,
  first_touch_medium: null,
  first_touch_campaign: null,
  first_touch_ad: null,
  first_touch_keyword: null,
  first_touch_landing_page: null,
  first_touch_referring_url: null,
  first_touch_device: null,
  call_tracking_number: null,
  referrer_id: null,
  referrer_type: null,
  referral_code: null,
  ad_platform_lead_id: null,
  created_by_location: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const fakeAppointment = {
  id: 'appt-1',
  lead_id: 'lead-1',
  location_id: 'loc-1',
  appointment_type: 'exam',
  scheduled_at: '2026-04-10T10:00:00Z',
  status: 'scheduled',
  notes: null,
  created_by: 'user-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createAppointment', () => {
  it('creates appointment when lead exists', async () => {
    vi.mocked(leadRepository.findById).mockResolvedValue(fakeLead);
    vi.mocked(appointmentRepository.createAppointment).mockResolvedValue(fakeAppointment);

    const result = await createAppointment(db, 'lead-1', {
      appointment_type: 'exam',
      scheduled_at: '2026-04-10T10:00:00Z',
    }, 'user-1');

    expect(leadRepository.findById).toHaveBeenCalledWith(db, 'lead-1');
    expect(appointmentRepository.createAppointment).toHaveBeenCalledWith(db, {
      lead_id: 'lead-1',
      location_id: 'loc-1',
      appointment_type: 'exam',
      scheduled_at: '2026-04-10T10:00:00Z',
      status: 'scheduled',
      notes: null,
      created_by: 'user-1',
    });
    expect(result).toEqual(fakeAppointment);
  });

  it('throws when lead not found', async () => {
    vi.mocked(leadRepository.findById).mockResolvedValue(null);

    await expect(
      createAppointment(db, 'missing-lead', {
        appointment_type: 'exam',
        scheduled_at: '2026-04-10T10:00:00Z',
      }, 'user-1'),
    ).rejects.toThrow('lead not found');
  });
});

describe('updateAppointment', () => {
  it('updates when appointment exists and belongs to lead', async () => {
    vi.mocked(appointmentRepository.findById).mockResolvedValue(fakeAppointment);
    vi.mocked(appointmentRepository.updateAppointment).mockResolvedValue({
      ...fakeAppointment,
      status: 'completed',
    });

    const result = await updateAppointment(db, 'appt-1', 'lead-1', { status: 'completed' });

    expect(appointmentRepository.findById).toHaveBeenCalledWith(db, 'appt-1');
    expect(appointmentRepository.updateAppointment).toHaveBeenCalledWith(db, 'appt-1', { status: 'completed' });
    expect(result.status).toBe('completed');
  });

  it('throws when appointment not found', async () => {
    vi.mocked(appointmentRepository.findById).mockResolvedValue(null);

    await expect(
      updateAppointment(db, 'missing', 'lead-1', { status: 'completed' }),
    ).rejects.toThrow('appointment not found');
  });

  it('throws when appointment belongs to different lead', async () => {
    vi.mocked(appointmentRepository.findById).mockResolvedValue({
      ...fakeAppointment,
      lead_id: 'other-lead',
    });

    await expect(
      updateAppointment(db, 'appt-1', 'lead-1', { status: 'completed' }),
    ).rejects.toThrow('appointment not found');
  });
});

describe('deleteAppointment', () => {
  it('delegates to repository', async () => {
    vi.mocked(appointmentRepository.deleteAppointment).mockResolvedValue(undefined);

    await deleteAppointment(db, 'appt-1');

    expect(appointmentRepository.deleteAppointment).toHaveBeenCalledWith(db, 'appt-1');
  });
});

describe('listAppointments', () => {
  it('delegates to repository findByLeadId', async () => {
    vi.mocked(appointmentRepository.findByLeadId).mockResolvedValue([fakeAppointment]);

    const result = await listAppointments(db, 'lead-1');

    expect(appointmentRepository.findByLeadId).toHaveBeenCalledWith(db, 'lead-1');
    expect(result).toEqual([fakeAppointment]);
  });
});
