import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { jsonApiError } from '../errors.js';

export async function snapshotRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audiences/snapshots/:snapshot_id', {
    schema: {
      querystring: Type.Object({
        limit: Type.Optional(Type.Integer({ default: 1000, minimum: 1, maximum: 10000 })),
        offset: Type.Optional(Type.Integer({ default: 0, minimum: 0 })),
      }),
      tags: ['Snapshots'],
      summary: 'Get audience snapshot',
    } as object,
  }, async (request, reply) => {
    const { snapshot_id } = request.params as { snapshot_id: string };
    const query = request.query as { limit?: number; offset?: number };
    const limit = query.limit ?? 1000;
    const offset = query.offset ?? 0;

    const snapshot = await app.snapshotsRepository.findById(snapshot_id);
    if (!snapshot) {
      return reply.status(404).send(
        jsonApiError(404, 'SNAPSHOT_NOT_FOUND', 'Snapshot not found'),
      );
    }

    const entityIds = await app.snapshotsRepository.findMembers(snapshot_id, limit, offset);

    return reply.status(200).send({
      snapshot_id: snapshot.id,
      segment_id: snapshot.segment_id ?? null,
      segment_version: snapshot.segment_version ?? null,
      status: snapshot.status,
      matched_count: snapshot.matched_count,
      expires_at: snapshot.expires_at,
      entity_ids: entityIds,
    });
  });
}
