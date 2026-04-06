import type { Knex } from 'knex';
import * as leadRepository from '../repositories/lead-repository.js';
import * as appointmentRepository from '../repositories/appointment-repository.js';
import type { Appointment } from '../repositories/appointment-repository.js';

export type { Appointment };

export async function createAppointment(
  db: Knex,
  leadId: string,
  data: { appointment_type: string; scheduled_at: string; notes?: string | null },
  createdBy: string,
): Promise<Appointment> {
  const lead = await leadRepository.findById(db, leadId);
  if (!lead) {
    throw new Error('lead not found');
  }

  return appointmentRepository.createAppointment(db, {
    lead_id: leadId,
    location_id: lead.location_id,
    appointment_type: data.appointment_type,
    scheduled_at: data.scheduled_at,
    status: 'scheduled',
    notes: data.notes ?? null,
    created_by: createdBy,
  });
}

export async function updateAppointment(
  db: Knex,
  appointmentId: string,
  leadId: string,
  fields: Partial<Pick<Appointment, 'status' | 'scheduled_at' | 'notes'>>,
): Promise<Appointment> {
  const appointment = await appointmentRepository.findById(db, appointmentId);
  if (!appointment || appointment.lead_id !== leadId) {
    throw new Error('appointment not found');
  }

  return appointmentRepository.updateAppointment(db, appointmentId, fields);
}

export async function deleteAppointment(db: Knex, appointmentId: string): Promise<void> {
  return appointmentRepository.deleteAppointment(db, appointmentId);
}

export async function listAppointments(db: Knex, leadId: string): Promise<Appointment[]> {
  return appointmentRepository.findByLeadId(db, leadId);
}
