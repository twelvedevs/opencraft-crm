import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import * as leadRepository from '../repositories/lead-repository.js';
import * as appointmentRepository from '../repositories/appointment-repository.js';
import type { Appointment } from '../repositories/appointment-repository.js';
import { publishAppointmentUpdated } from '../events/publisher.js';

export type { Appointment };

export async function createAppointment(
  db: Knex,
  leadId: string,
  data: { appointment_type: string; scheduled_at: string; notes?: string | null },
  createdBy: string,
  eventBus: EventBus,
): Promise<Appointment> {
  const lead = await leadRepository.findById(db, leadId);
  if (!lead) {
    throw new Error('lead not found');
  }

  const appointment = await appointmentRepository.createAppointment(db, {
    lead_id: leadId,
    location_id: lead.location_id,
    appointment_type: data.appointment_type,
    scheduled_at: data.scheduled_at,
    status: 'scheduled',
    notes: data.notes ?? null,
    created_by: createdBy,
  });

  await publishAppointmentUpdated(eventBus, {
    lead_id: leadId,
    appointment_id: appointment.id,
    appointment_type: appointment.appointment_type,
    scheduled_at: appointment.scheduled_at,
    status: appointment.status,
    location_id: appointment.location_id,
  });

  return appointment;
}

export async function updateAppointment(
  db: Knex,
  appointmentId: string,
  leadId: string,
  fields: Partial<Pick<Appointment, 'status' | 'scheduled_at' | 'notes'>>,
  eventBus: EventBus,
): Promise<Appointment> {
  const appointment = await appointmentRepository.findById(db, appointmentId);
  if (!appointment || appointment.lead_id !== leadId) {
    throw new Error('appointment not found');
  }

  const updated = await appointmentRepository.updateAppointment(db, appointmentId, fields);

  // Only publish if status was changed
  if (fields.status !== undefined) {
    await publishAppointmentUpdated(eventBus, {
      lead_id: updated.lead_id,
      appointment_id: updated.id,
      appointment_type: updated.appointment_type,
      scheduled_at: updated.scheduled_at,
      status: updated.status,
      location_id: updated.location_id,
    });
  }

  return updated;
}

export async function deleteAppointment(db: Knex, appointmentId: string): Promise<void> {
  return appointmentRepository.deleteAppointment(db, appointmentId);
}

export async function listAppointments(db: Knex, leadId: string): Promise<Appointment[]> {
  return appointmentRepository.findByLeadId(db, leadId);
}
