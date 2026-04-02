import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { jsonApiError } from '../errors.js';
import { FilterEvaluator } from '../services/filter-evaluator.js';
import { SegmentMismatchError, SnapshotSizeExceededError } from '../services/snapshot-manager.js';

const EvaluateBody = Type.Object({
  snapshot_id: Type.String(),
  entities: Type.Array(Type.Unknown()),
  done: Type.Boolean(),
});

const InlineEvaluateBody = Type.Object({
  snapshot_id: Type.Optional(Type.String()),
  filter: Type.Unknown(),
  entities: Type.Array(Type.Unknown()),
  done: Type.Boolean(),
  snapshot: Type.Optional(Type.Boolean()),
});

export async function evaluateRoutes(app: FastifyInstance): Promise<void> {
  // Named segment batch evaluate
  app.post('/audiences/segments/:id/evaluate', {
    schema: { body: EvaluateBody },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      snapshot_id: string;
      entities: Array<{ entity_id: string; [key: string]: unknown }>;
      done: boolean;
    };

    // Validate snapshot_id
    if (!body.snapshot_id) {
      return reply.status(400).send(
        jsonApiError(400, 'MISSING_SNAPSHOT_ID', 'snapshot_id is required'),
      );
    }

    // Validate entities count
    if (body.entities.length > 1000) {
      return reply.status(413).send(
        jsonApiError(413, 'BATCH_TOO_LARGE', 'Maximum 1000 entities per batch'),
      );
    }

    // Load segment
    const segment = await app.segmentRepository.getActiveWithFilter(id);
    if (!segment) {
      return reply.status(404).send(
        jsonApiError(404, 'SEGMENT_NOT_FOUND', 'Segment not found or not active'),
      );
    }

    // Check if snapshot is already sealed
    const existingSnapshot = await app.snapshotsRepository.findById(body.snapshot_id);
    if (existingSnapshot && existingSnapshot.status === 'ready') {
      return reply.status(400).send(
        jsonApiError(400, 'SNAPSHOT_ALREADY_SEALED', 'Snapshot is already sealed'),
      );
    }

    try {
      const result = await app.snapshotManager.processBatch({
        snapshotId: body.snapshot_id,
        segmentId: id,
        segmentVersion: segment.active_version,
        filterSnapshot: segment.filter,
        entities: body.entities,
        done: body.done,
        createdBy: null,
      });

      return reply.status(200).send({
        snapshot_id: result.snapshotId,
        matched_count: result.matchedCount,
        status: result.status,
      });
    } catch (err) {
      if (err instanceof SegmentMismatchError) {
        return reply.status(400).send(
          jsonApiError(400, 'SEGMENT_MISMATCH', 'Snapshot belongs to a different segment'),
        );
      }
      if (err instanceof SnapshotSizeExceededError) {
        return reply.status(400).send(
          jsonApiError(400, 'SNAPSHOT_SIZE_EXCEEDED', 'Snapshot would exceed the 100,000 member cap'),
        );
      }
      throw err;
    }
  });

  // Inline evaluate (no stored segment)
  app.post('/audiences/evaluate', {
    schema: { body: InlineEvaluateBody },
  }, async (request, reply) => {
    const body = request.body as {
      snapshot_id?: string;
      filter: unknown;
      entities: Array<{ entity_id: string; [key: string]: unknown }>;
      done: boolean;
      snapshot?: boolean;
    };

    const useSnapshot = body.snapshot ?? false;

    // Validate entities count
    if (body.entities.length > 1000) {
      return reply.status(413).send(
        jsonApiError(413, 'BATCH_TOO_LARGE', 'Maximum 1000 entities per batch'),
      );
    }

    // Validate filter
    if (!body.filter || typeof body.filter !== 'object') {
      return reply.status(400).send(
        jsonApiError(400, 'INVALID_REQUEST', 'filter is required and must be an object'),
      );
    }

    // snapshot:false requires done:true
    if (!useSnapshot && !body.done) {
      return reply.status(400).send(
        jsonApiError(400, 'INVALID_REQUEST', 'snapshot:false requires done:true'),
      );
    }

    // snapshot:true requires snapshot_id
    if (useSnapshot && !body.snapshot_id) {
      return reply.status(400).send(
        jsonApiError(400, 'MISSING_SNAPSHOT_ID', 'snapshot_id is required when snapshot:true'),
      );
    }

    if (!useSnapshot) {
      // Inline evaluation — no DB writes
      const filterEvaluator = new FilterEvaluator();
      const matchedIds: string[] = [];
      for (const entity of body.entities) {
        if (filterEvaluator.evaluate(body.filter, entity)) {
          matchedIds.push(entity.entity_id);
        }
      }
      return reply.status(200).send({
        matched_count: matchedIds.length,
        entity_ids: matchedIds,
      });
    }

    // Snapshot mode — accumulate into snapshot
    const snapshotId = body.snapshot_id!;

    // Check filter mismatch on existing snapshot
    const existingSnapshot = await app.snapshotsRepository.findById(snapshotId);
    if (existingSnapshot) {
      if (existingSnapshot.status === 'ready') {
        return reply.status(400).send(
          jsonApiError(400, 'SNAPSHOT_ALREADY_SEALED', 'Snapshot is already sealed'),
        );
      }
      if (JSON.stringify(existingSnapshot.filter_snapshot) !== JSON.stringify(body.filter)) {
        return reply.status(400).send(
          jsonApiError(400, 'FILTER_MISMATCH', 'Filter does not match the existing snapshot filter'),
        );
      }
    }

    try {
      const result = await app.snapshotManager.processBatch({
        snapshotId,
        segmentId: null,
        segmentVersion: null,
        filterSnapshot: body.filter,
        entities: body.entities,
        done: body.done,
        createdBy: null,
      });

      return reply.status(200).send({
        snapshot_id: result.snapshotId,
        matched_count: result.matchedCount,
        status: result.status,
      });
    } catch (err) {
      if (err instanceof SnapshotSizeExceededError) {
        return reply.status(400).send(
          jsonApiError(400, 'SNAPSHOT_SIZE_EXCEEDED', 'Snapshot would exceed the 100,000 member cap'),
        );
      }
      throw err;
    }
  });
}
