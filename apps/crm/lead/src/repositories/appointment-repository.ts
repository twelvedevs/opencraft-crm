import type { Knex } from 'knex';

export interface Appointment {
  id: string;
  lead_id: string;
  location_id: string;
  appointment_type: string;
  scheduled_at: string;
  status: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateAppointmentData {
  lead_id: string;
  location_id: string;
  appointment_type: string;
  scheduled_at: string;
  status: string;
  notes?: string | null;
  created_by: string;
}

export type UpdateAppointmentFields = Partial<
  Pick<Appointment, 'status' | 'scheduled_at' | 'notes'>
>;

const TABLE = 'crm_leads.appointments';

export function createAppointment(db: Knex, data: CreateAppointmentData): Promise<Appointment> {
  return db(TABLE)
    .insert(data)
    .returning('*')
    .then((rows) => rows[0] as Appointment);
}

export function findById(db: Knex, id: string): Promise<Appointment | null> {
  return db(TABLE)
    .where({ id })
    .first()
    .then((row) => (row as Appointment) ?? null);
}

export function findByLeadId(db: Knex, leadId: string): Promise<Appointment[]> {
  return db(TABLE)
    .where({ lead_id: leadId })
    .orderBy('scheduled_at', 'asc')
    .then((rows) => rows as Appointment[]);
}

export function updateAppointment(
  db: Knex,
  id: string,
  fields: UpdateAppointmentFields,
): Promise<Appointment> {
  return db(TABLE)
    .where({ id })
    .update({ ...fields, updated_at: db.fn.now() })
    .returning('*')
    .then((rows) => rows[0] as Appointment);
}

export function deleteAppointment(db: Knex, id: string): Promise<void> {
  return db(TABLE)
    .where({ id })
    .delete()
    .then(() => undefined);
}
