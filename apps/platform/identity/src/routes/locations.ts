import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Pool } from 'pg';
import { requireRole } from '@ortho/auth-middleware';
import * as locationRepo from '../repositories/location.repo.js';

const superAdminOnly = requireRole(['super_admin']);

const IdParams = Type.Object({ id: Type.String() });

const CreateLocationBody = Type.Object({
  name: Type.String(),
  phone: Type.String(),
  address: Type.String(),
  timezone: Type.String(),
});

const PatchLocationBody = Type.Object({
  name: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  address: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
});

const ListLocationsQuery = Type.Object({
  status: Type.Optional(Type.String()),
});

export async function locationsRoutes(app: FastifyInstance, opts: { pool: Pool }): Promise<void> {
  const { pool } = opts;

  // GET /identity/locations
  app.get('/identity/locations', {
    schema: { querystring: ListLocationsQuery, tags: ['Locations'], summary: 'List locations' } as object,
  }, async (req, reply) => {
    const { status } = req.query as { status?: string };
    const locations = await locationRepo.findAll(pool, status);
    return reply.status(200).send({ locations });
  });

  // GET /identity/locations/:id
  app.get('/identity/locations/:id', {
    schema: { params: IdParams, tags: ['Locations'], summary: 'Get location by ID' } as object,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const location = await locationRepo.findById(pool, id);
    if (!location) return reply.status(404).send({ error: 'not_found' });
    return reply.status(200).send(location);
  });

  // POST /identity/locations
  app.post('/identity/locations', {
    schema: { body: CreateLocationBody, tags: ['Locations'], summary: 'Create location' } as object,
    preHandler: [superAdminOnly],
  }, async (req, reply) => {
    const body = req.body as { name: string; phone: string; address: string; timezone: string };
    const location = await locationRepo.create(pool, body);
    return reply.status(201).send(location);
  });

  // PATCH /identity/locations/:id
  app.patch('/identity/locations/:id', {
    schema: { params: IdParams, body: PatchLocationBody, tags: ['Locations'], summary: 'Update location' } as object,
    preHandler: [superAdminOnly],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<{ name: string; phone: string; address: string; timezone: string; status: string }>;
    const location = await locationRepo.update(pool, id, body);
    if (!location) return reply.status(404).send({ error: 'not_found' });
    return reply.status(200).send(location);
  });

  // DELETE /identity/locations/:id — soft delete (sets status=inactive)
  app.delete('/identity/locations/:id', {
    schema: { params: IdParams, tags: ['Locations'], summary: 'Deactivate location (soft delete)' } as object,
    preHandler: [superAdminOnly],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    let found: boolean;
    try {
      found = await locationRepo.softDelete(pool, id);
    } catch (err: unknown) {
      // FK violation: location has users assigned
      const error = err as { code?: string };
      if (error.code === '23503') {
        return reply.status(409).send({ error: 'location_has_users' });
      }
      throw err;
    }
    if (!found) return reply.status(404).send({ error: 'not_found' });
    return reply.status(204).send();
  });
}
