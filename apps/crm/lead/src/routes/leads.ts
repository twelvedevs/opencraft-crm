import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { Type } from '@sinclair/typebox';
import { requireRole } from '@ortho/auth-middleware';
import '@ortho/auth-middleware';
import * as leadService from '../services/lead-service.js';
import * as leadRepository from '../repositories/lead-repository.js';
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

const ListLeadsQuery = Type.Object({
  location_id: Type.Optional(Type.String()),
  pipeline: Type.Optional(Type.String()),
  stage: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('archived')])),
  contact_status: Type.Optional(Type.String()),
  channel: Type.Optional(Type.String()),
  tag_id: Type.Optional(Type.Array(Type.String())),
  q: Type.Optional(Type.String()),
  include_archived: Type.Optional(Type.Boolean()),
  sort: Type.Optional(Type.Union([
    Type.Literal('score'),
    Type.Literal('created_at'),
    Type.Literal('last_activity_at'),
  ])),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ default: 50, maximum: 200 })),
  phones: Type.Optional(Type.Array(Type.String())),
  emails: Type.Optional(Type.Array(Type.String())),
  ids: Type.Optional(Type.Array(Type.String())),
});

const MANAGER_ROLES = ['call_center_manager', 'marketing_staff', 'marketing_manager', 'super_admin'];
const managerOnly = requireRole(MANAGER_ROLES);

export async function leadsRoutes(
  app: FastifyInstance,
  opts: { db: Knex; eventBus: EventBus },
): Promise<void> {
  const { db, eventBus } = opts;

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
      const lead = await leadService.createLead(
        db,
        body as Parameters<typeof leadService.createLead>[1],
        eventBus,
        req.user!.sub,
      );
      return reply.status(201).send(lead);
    } catch (err) {
      if (err instanceof Error && err.message === 'invalid phone number') {
        return reply.status(400).send({ error: 'invalid phone number' });
      }
      throw err;
    }
  });

  // GET /leads/duplicates — paginated list of flagged duplicates
  app.get('/leads/duplicates', {
    schema: {
      querystring: Type.Object({
        cursor: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ default: 50, maximum: 200 })),
      }),
    },
  }, async (req, reply) => {
    const query = req.query as { cursor?: string; limit?: number };
    const userLocations = req.user?.locations ?? [];
    const result = await leadRepository.findFlaggedDuplicates(
      db,
      userLocations,
      query.cursor,
      query.limit,
    );
    return reply.status(200).send(result);
  });

  // PATCH /leads/:id/duplicate-status
  app.patch('/leads/:id/duplicate-status', {
    schema: {
      params: IdParams,
      body: Type.Object({
        status: Type.Literal('resolved'),
      }),
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const lead = await leadRepository.findById(db, id);
    if (!lead) {
      return reply.status(404).send({ error: 'not found' });
    }

    const updated = await leadRepository.updateLead(db, id, {
      duplicate_status: 'resolved',
      duplicate_of_id: null,
    });
    return reply.status(200).send(updated);
  });

  // GET /leads — list with filters, bulk lookup, search, cursor pagination
  app.get('/leads', {
    schema: { querystring: ListLeadsQuery },
  }, async (req, reply) => {
    const query = req.query as {
      location_id?: string;
      pipeline?: string;
      stage?: string;
      status?: 'active' | 'archived';
      contact_status?: string;
      channel?: string;
      tag_id?: string[];
      q?: string;
      include_archived?: boolean;
      sort?: 'score' | 'created_at' | 'last_activity_at';
      cursor?: string;
      limit?: number;
      phones?: string[];
      emails?: string[];
      ids?: string[];
    };

    const userLocations = req.user?.locations ?? [];

    // Bulk lookup limit validation
    if (query.phones && query.phones.length > 100) {
      return reply.status(400).send({ error: 'bulk lookup limit exceeded' });
    }
    if (query.emails && query.emails.length > 100) {
      return reply.status(400).send({ error: 'bulk lookup limit exceeded' });
    }
    if (query.ids && query.ids.length > 500) {
      return reply.status(400).send({ error: 'bulk lookup limit exceeded' });
    }

    // Bulk lookup mode — bypass pagination
    if (query.phones) {
      const leads = await leadRepository.findByPhones(db, query.phones, userLocations);
      return reply.status(200).send({ leads });
    }
    if (query.emails) {
      const leads = await leadRepository.findByEmails(db, query.emails, userLocations);
      return reply.status(200).send({ leads });
    }
    if (query.ids) {
      const leads = await leadRepository.findByIds(db, query.ids, userLocations);
      return reply.status(200).send({ leads });
    }

    // Normal list mode
    const result = await leadService.listLeads(
      db,
      {
        pipeline: query.pipeline,
        stage: query.stage,
        status: query.status,
        contactStatus: query.contact_status,
        channel: query.channel,
        tagIds: query.tag_id,
        q: query.q,
        includeArchived: query.include_archived,
        sort: query.sort,
        cursor: query.cursor,
        limit: query.limit,
      },
      query.location_id ? [query.location_id] : userLocations,
    );

    return reply.status(200).send(result);
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
      const lead = await leadService.updateLead(db, id, body, eventBus);
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

    await leadService.archiveLead(db, id, eventBus);
    return reply.status(204).send();
  });
}
