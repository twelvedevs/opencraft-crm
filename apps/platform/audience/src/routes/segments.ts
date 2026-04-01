import crypto from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { SegmentsRepository } from '../repositories/segments.repository.js';
import { jsonApiError } from '../errors.js';

const CreateSegmentBody = Type.Object({
  name: Type.String(),
  filter: Type.Unknown(),
});

const UpdateSegmentBody = Type.Object({
  filter: Type.Unknown(),
});

const ListSegmentsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  status: Type.Optional(Type.String()),
});

export async function segmentRoutes(app: FastifyInstance): Promise<void> {
  const segmentsRepo = new SegmentsRepository(app.db);

  // POST /audiences/segments
  app.post('/audiences/segments', {
    schema: { body: CreateSegmentBody },
  }, async (request, reply) => {
    const body = request.body as { name: string; filter: unknown };

    if (!body.filter || typeof body.filter !== 'object') {
      return reply.status(400).send(
        jsonApiError(400, 'INVALID_REQUEST', 'filter must be a non-null object'),
      );
    }

    const segmentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();

    await app.db.transaction(async (trx) => {
      const txRepo = new SegmentsRepository(trx as unknown as import('../db.js').Knex);
      await txRepo.create({
        id: segmentId,
        name: body.name,
        created_by: null,
      });
      await txRepo.createVersion({
        id: versionId,
        segment_id: segmentId,
        version: 1,
        filter: body.filter,
        created_by: null,
      });
    });

    return reply.status(201).send({
      segment_id: segmentId,
      version: 1,
      status: 'draft',
    });
  });

  // PUT /audiences/segments/:id
  app.put('/audiences/segments/:id', {
    schema: { body: UpdateSegmentBody },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { filter: unknown };

    if (!body.filter || typeof body.filter !== 'object') {
      return reply.status(400).send(
        jsonApiError(400, 'INVALID_REQUEST', 'filter must be a non-null object'),
      );
    }

    const segment = await segmentsRepo.findById(id);
    if (!segment) {
      return reply.status(404).send(
        jsonApiError(404, 'NOT_FOUND', 'Segment not found'),
      );
    }

    // Versioning logic
    if (segment.active_version == null || segment.current_version > segment.active_version) {
      // Draft never activated or current version is ahead — overwrite draft
      await segmentsRepo.updateCurrentVersionFilter(id, segment.current_version, body.filter);
      app.segmentRepository.invalidate(id);
      return reply.status(200).send({
        segment_id: id,
        version: segment.current_version,
        status: segment.status,
      });
    }

    // current_version === active_version — create new version
    const newVersion = await segmentsRepo.incrementVersion(id);
    const versionId = crypto.randomUUID();
    await segmentsRepo.createVersion({
      id: versionId,
      segment_id: id,
      version: newVersion,
      filter: body.filter,
      created_by: null,
    });
    app.segmentRepository.invalidate(id);

    return reply.status(200).send({
      segment_id: id,
      version: newVersion,
      status: 'draft',
    });
  });

  // GET /audiences/segments
  app.get('/audiences/segments', {
    schema: { querystring: ListSegmentsQuery },
  }, async (request, reply) => {
    const query = request.query as { limit?: number; offset?: number; status?: string };
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const statusArray = query.status ? query.status.split(',').map((s) => s.trim()) : undefined;

    const result = await segmentsRepo.list(
      { status: statusArray },
      { limit, offset },
    );

    return reply.status(200).send({
      items: result.items.map((s) => ({
        segment_id: s.id,
        name: s.name,
        status: s.status,
        active_version: s.active_version,
        current_version: s.current_version,
        updated_at: s.updated_at,
      })),
      total: result.total,
    });
  });

  // POST /audiences/segments/:id/activate
  // TODO: Add Marketing Manager role check (403) when @ortho/auth-middleware is wired up
  app.post('/audiences/segments/:id/activate', async (request, reply) => {
    const { id } = request.params as { id: string };

    const segment = await segmentsRepo.findById(id);
    if (!segment) {
      return reply.status(404).send(
        jsonApiError(404, 'NOT_FOUND', 'Segment not found'),
      );
    }

    // Verify a version row exists for current_version
    const versionRow = await segmentsRepo.findVersionRow(id, segment.current_version);
    if (!versionRow) {
      return reply.status(400).send(
        jsonApiError(400, 'NO_FILTER_VERSION', 'No filter version for current_version'),
      );
    }

    await segmentsRepo.updateStatus(id, 'active', segment.current_version);
    app.segmentRepository.invalidate(id);

    return reply.status(200).send({
      segment_id: id,
      active_version: segment.current_version,
      status: 'active',
    });
  });

  // POST /audiences/segments/:id/disable
  // TODO: Add Marketing Manager role check (403) when @ortho/auth-middleware is wired up
  app.post('/audiences/segments/:id/disable', async (request, reply) => {
    const { id } = request.params as { id: string };

    const segment = await segmentsRepo.findById(id);
    if (!segment) {
      return reply.status(404).send(
        jsonApiError(404, 'NOT_FOUND', 'Segment not found'),
      );
    }

    await segmentsRepo.updateStatus(id, 'disabled');
    app.segmentRepository.invalidate(id);

    return reply.status(200).send({
      segment_id: id,
      status: 'disabled',
    });
  });

  // GET /audiences/segments/:id
  app.get('/audiences/segments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const segment = await segmentsRepo.findById(id);
    if (!segment) {
      return reply.status(404).send(
        jsonApiError(404, 'NOT_FOUND', 'Segment not found'),
      );
    }

    if (segment.status === 'active' && segment.active_version != null) {
      const versionRow = await segmentsRepo.findVersionRow(id, segment.active_version);
      return reply.status(200).send({
        segment_id: segment.id,
        name: segment.name,
        status: segment.status,
        active_version: segment.active_version,
        current_version: segment.current_version,
        filter: versionRow?.filter ?? null,
      });
    }

    // draft or disabled
    return reply.status(200).send({
      segment_id: segment.id,
      name: segment.name,
      status: segment.status,
      active_version: segment.active_version,
      current_version: segment.current_version,
      filter: null,
    });
  });
}
