import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { jsonApiError } from '../errors.js';
import { SegmentMismatchError, SnapshotSizeExceededError } from '../services/snapshot-manager.js';

const EvaluateBody = Type.Object({
  snapshot_id: Type.String(),
  entities: Type.Array(Type.Unknown()),
  done: Type.Boolean(),
});

export async function evaluateRoutes(app: FastifyInstance): Promise<void> {
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
}
