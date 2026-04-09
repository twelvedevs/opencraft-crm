import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { requirePermission } from '@ortho/auth-middleware';
import * as referrerService from '../services/referrer.service.js';
import * as portalTokenRepo from '../repositories/portal-token.repo.js';
import * as referrerRepo from '../repositories/referrer.repo.js';
import { env } from '../env.js';

const IdParams = Type.Object({
  id: Type.String(),
});

const CreateReferrerBody = Type.Object({
  referrer_type: Type.String(),
  name: Type.String(),
  location_id: Type.String(),
  phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  practice_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const PatchReferrerBody = Type.Object({
  name: Type.Optional(Type.String()),
  phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  practice_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const PatchStatusBody = Type.Object({
  status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
});

const ListReferrersQuery = Type.Object({
  location_id: Type.String(),
  referrer_type: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});

const readPerm = requirePermission('referrals:read');
const writePerm = requirePermission('referrals:write');

export async function referrersRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // POST /referrers — create doctor referrer + initial link
  app.post('/', {
    schema: { body: CreateReferrerBody },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const body = req.body as {
      referrer_type: string;
      name: string;
      location_id: string;
      phone?: string | null;
      email?: string | null;
      practice_name?: string | null;
      address?: string | null;
    };

    if (body.referrer_type !== 'doctor') {
      return reply.status(400).send({ error: 'Only doctor referrers can be created via this endpoint' });
    }

    const result = await referrerService.createDoctorReferrer(db, {
      ...body,
      created_by: req.user!.sub,
    });

    return reply.status(201).send(result);
  });

  // GET /referrers — paginated list
  app.get('/', {
    schema: { querystring: ListReferrersQuery },
    preHandler: [readPerm],
  }, async (req, reply) => {
    const query = req.query as {
      location_id: string;
      referrer_type?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    };

    const result = await referrerService.list(db, query);
    return reply.status(200).send(result);
  });

  // GET /referrers/:id — full record with active link + summary counts
  app.get('/:id', {
    schema: { params: IdParams },
    preHandler: [readPerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const result = await referrerService.getWithSummary(db, id);
    if (!result) {
      return reply.status(404).send({ error: 'Referrer not found' });
    }

    return reply.status(200).send(result);
  });

  // PATCH /referrers/:id — update doctor contact fields only
  app.patch('/:id', {
    schema: { params: IdParams, body: PatchReferrerBody },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;

    // Reject attempts to change immutable fields
    const immutableFields = ['lead_id', 'referrer_type', 'location_id'];
    for (const field of immutableFields) {
      if (field in body) {
        return reply.status(400).send({ error: `Cannot change ${field}` });
      }
    }

    const referrer = await referrerRepo.findById(db, id);
    if (!referrer) {
      return reply.status(404).send({ error: 'Referrer not found' });
    }

    const updated = await referrerService.updateDoctorInfo(db, id, body as {
      name?: string;
      phone?: string | null;
      email?: string | null;
      practice_name?: string | null;
      address?: string | null;
    });

    return reply.status(200).send(updated);
  });

  // PATCH /referrers/:id/status — { status: 'active'|'inactive' }
  app.patch('/:id/status', {
    schema: { params: IdParams, body: PatchStatusBody },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status: string };

    const referrer = await referrerRepo.findById(db, id);
    if (!referrer) {
      return reply.status(404).send({ error: 'Referrer not found' });
    }

    const updated = await referrerService.updateStatus(db, id, status);
    return reply.status(200).send(updated);
  });

  // POST /referrers/:id/portal-token — generate/replace portal token
  app.post('/:id/portal-token', {
    schema: { params: IdParams },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const referrer = await referrerRepo.findById(db, id);
    if (!referrer) {
      return reply.status(404).send({ error: 'Referrer not found' });
    }

    if (referrer.referrer_type === 'patient') {
      return reply.status(400).send({ error: 'Portal tokens are not available for patient referrers' });
    }

    const portalToken = await portalTokenRepo.upsertForReferrer(db, {
      referrer_id: id,
      created_by: req.user!.sub,
    });

    return reply.status(201).send({
      token: portalToken.token,
      portal_url: `${env.REFERRAL_BASE_URL}/referrals/portal/${portalToken.token}`,
    });
  });
}
