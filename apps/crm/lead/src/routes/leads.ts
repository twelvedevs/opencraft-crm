import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { requireRole } from '@ortho/auth-middleware';
import '@ortho/auth-middleware';
import * as leadService from '../services/lead-service.js';
import * as tagRepository from '../repositories/tag-repository.js';
import * as appointmentRepository from '../repositories/appointment-repository.js';

const CHANNEL_ENUM = [
  'website_form',
  'google_ads',
  'facebook_ads',
  'call_tracking',
  'referral',
  'walk_in',
  'chat',
  'google_business_profile',
  'csv_import',
] as const;

const CreateLeadBody = Type.Object({
  first_name: Type.String(),
  last_name: Type.String(),
  phone: Type.String(),
  channel: Type.Enum(Object.fromEntries(CHANNEL_ENUM.map((c) => [c, c]))),
  email: Type.Optional(Type.String()),
  treatment_interest: Type.Optional(Type.String()),
  date_of_birth: Type.Optional(Type.String()),
  location_id: Type.Optional(Type.String()),
  first_touch_source: Type.Optional(Type.String()),
  first_touch_medium: Type.Optional(Type.String()),
  first_touch_campaign: Type.Optional(Type.String()),
  first_touch_ad: Type.Optional(Type.String()),
  first_touch_keyword: Type.Optional(Type.String()),
  first_touch_landing_page: Type.Optional(Type.String()),
  first_touch_referring_url: Type.Optional(Type.String()),
  first_touch_device: Type.Optional(Type.String()),
  call_tracking_number: Type.Optional(Type.String()),
  referrer_id: Type.Optional(Type.String()),
  referrer_type: Type.Optional(Type.String()),
  referral_code: Type.Optional(Type.String()),
  ad_platform_lead_id: Type.Optional(Type.String()),
  created_by_location: Type.Optional(Type.String()),
});

const IdParams = Type.Object({
  id: Type.String(),
});

const PatchLeadBody = Type.Object({
  first_name: Type.Optional(Type.String()),
  last_name: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  treatment_interest: Type.Optional(Type.String()),
  location_id: Type.Optional(Type.String()),
});

const MANAGER_ROLES = ['call_center_manager', 'marketing_staff', 'marketing_manager', 'super_admin'];
const managerOnly = requireRole(MANAGER_ROLES);

export async function leadsRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // POST /leads
  app.post('/leads', {
    schema: { body: CreateLeadBody },
  }, async (req, reply) => {
    const body = req.body as {
      first_name: string;
      last_name: string;
      phone: string;
      channel: string;
      email?: string;
      treatment_interest?: string;
      date_of_birth?: string;
      location_id?: string;
      first_touch_source?: string;
      first_touch_medium?: string;
      first_touch_campaign?: string;
      first_touch_ad?: string;
      first_touch_keyword?: string;
      first_touch_landing_page?: string;
      first_touch_referring_url?: string;
      first_touch_device?: string;
      call_tracking_number?: string;
      referrer_id?: string;
      referrer_type?: string;
      referral_code?: string;
      ad_platform_lead_id?: string;
      created_by_location?: string;
    };

    try {
      const lead = await leadService.createLead(db, body as Parameters<typeof leadService.createLead>[1]);
      return reply.status(201).send(lead);
    } catch (err) {
      if (err instanceof Error && err.message === 'invalid phone number') {
        return reply.status(400).send({ error: 'invalid phone number' });
      }
      throw err;
    }
  });

  // GET /leads/:id
  app.get('/leads/:id', {
    schema: { params: IdParams },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const lead = await leadService.getLead(db, id);
    if (!lead) {
      return reply.status(404).send({ error: 'not found' });
    }

    const [tags, appointments] = await Promise.all([
      tagRepository.findTagsByLeadId(db, id),
      appointmentRepository.findByLeadId(db, id),
    ]);

    return reply.status(200).send({ ...lead, tags, appointments });
  });

  // PATCH /leads/:id
  app.patch('/leads/:id', {
    schema: { params: IdParams, body: PatchLeadBody },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      first_name?: string;
      last_name?: string;
      phone?: string;
      email?: string;
      treatment_interest?: string;
      location_id?: string;
    };

    // location_id reassignment requires manager role
    if (body.location_id !== undefined) {
      const role = req.user?.role;
      if (!role || !MANAGER_ROLES.includes(role)) {
        return reply.status(403).send({ error: 'forbidden' });
      }
    }

    try {
      const lead = await leadService.updateLead(db, id, body);
      return reply.status(200).send(lead);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'attribution fields are immutable') {
          return reply.status(400).send({ error: 'attribution fields are immutable' });
        }
        if (err.message === 'invalid phone number') {
          return reply.status(400).send({ error: 'invalid phone number' });
        }
      }
      throw err;
    }
  });

  // DELETE /leads/:id
  app.delete('/leads/:id', {
    schema: { params: IdParams },
    preHandler: [managerOnly],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const lead = await leadService.getLead(db, id);
    if (!lead || lead.archived_at) {
      return reply.status(404).send({ error: 'not found' });
    }

    await leadService.archiveLead(db, id);
    return reply.status(204).send();
  });
}
