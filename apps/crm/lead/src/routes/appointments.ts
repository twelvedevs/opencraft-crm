import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { Type } from '@sinclair/typebox';
import '@ortho/auth-middleware';
import * as leadRepository from '../repositories/lead-repository.js';
import * as appointmentService from '../services/appointment-service.js';
import * as appointmentRepository from '../repositories/appointment-repository.js';
import { serviceAuthHook } from '../middleware/service-auth.js';

const LeadIdParams = Type.Object({
  id: Type.String(),
});

const AppointmentParams = Type.Object({
  id: Type.String(),
  appt_id: Type.String(),
});

const CreateAppointmentBody = Type.Object({
  appointment_type: Type.Union([
    Type.Literal('exam'),
    Type.Literal('follow_up'),
    Type.Literal('other'),
  ]),
  scheduled_at: Type.String(),
  notes: Type.Optional(Type.String()),
});

const PatchAppointmentBody = Type.Object({
  status: Type.Optional(Type.Union([
    Type.Literal('scheduled'),
    Type.Literal('completed'),
    Type.Literal('cancelled'),
    Type.Literal('no_show'),
  ])),
  scheduled_at: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

export async function appointmentRoutes(
  app: FastifyInstance,
  opts: { db: Knex; eventBus: EventBus },
): Promise<void> {
  const { db, eventBus } = opts;

  // POST /leads/:id/appointments
  app.post('/leads/:id/appointments', {
    schema: { params: LeadIdParams, body: CreateAppointmentBody, tags: ['Appointments'], summary: 'Create appointment' } as object,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { appointment_type: string; scheduled_at: string; notes?: string };

    try {
      const appointment = await appointmentService.createAppointment(db, id, body, req.user!.sub, eventBus);
      return reply.status(201).send(appointment);
    } catch (err) {
      if (err instanceof Error && err.message === 'lead not found') {
        return reply.status(404).send({ error: 'not found' });
      }
      throw err;
    }
  });

  // GET /leads/:id/appointments
  app.get('/leads/:id/appointments', {
    schema: { params: LeadIdParams, tags: ['Appointments'], summary: 'List lead appointments' } as object,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lead = await leadRepository.findById(db, id);
    if (!lead) {
      return reply.status(404).send({ error: 'not found' });
    }
    const appointments = await appointmentService.listAppointments(db, id);
    return reply.status(200).send(appointments);
  });

  // PATCH /leads/:id/appointments/:appt_id
  app.patch('/leads/:id/appointments/:appt_id', {
    schema: { params: AppointmentParams, body: PatchAppointmentBody, tags: ['Appointments'], summary: 'Update appointment' } as object,
  }, async (req, reply) => {
    const { id, appt_id } = req.params as { id: string; appt_id: string };
    const body = req.body as { status?: string; scheduled_at?: string; notes?: string };

    try {
      const appointment = await appointmentService.updateAppointment(db, appt_id, id, body, eventBus);
      return reply.status(200).send(appointment);
    } catch (err) {
      if (err instanceof Error && err.message === 'appointment not found') {
        return reply.status(404).send({ error: 'not found' });
      }
      throw err;
    }
  });

  // DELETE /leads/:id/appointments/:appt_id — internal service-auth only
  app.delete('/leads/:id/appointments/:appt_id', {
    schema: { params: AppointmentParams, tags: ['Appointments'], summary: 'Delete appointment' } as object,
    config: { skipAuth: true },
    preHandler: [serviceAuthHook],
  }, async (req, reply) => {
    const { appt_id } = req.params as { id: string; appt_id: string };

    const existing = await appointmentRepository.findById(db, appt_id);
    if (!existing) {
      return reply.status(404).send({ error: 'not found' });
    }

    await appointmentService.deleteAppointment(db, appt_id);
    return reply.status(204).send();
  });
}
