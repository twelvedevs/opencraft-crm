import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { FilterEvaluator } from '../services/filter-evaluator.js';
import { jsonApiError } from '../errors.js';

const CheckBody = Type.Object({
  entity: Type.Record(Type.String(), Type.Unknown()),
});

export async function checkRoutes(app: FastifyInstance): Promise<void> {
  const filterEvaluator = new FilterEvaluator();

  app.post('/audiences/segments/:id/check', {
    schema: { body: CheckBody, tags: ['Evaluation'], summary: 'Check single entity membership' } as object,
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { entity } = request.body as { entity: Record<string, unknown> };

    const segment = await app.segmentRepository.getActiveWithFilter(id);

    if (!segment) {
      return reply.status(404).send(
        jsonApiError(404, 'SEGMENT_NOT_FOUND', 'Segment not found or not active'),
      );
    }

    const matches = filterEvaluator.evaluate(segment.filter, entity);

    return reply.status(200).send({
      matches,
      segment_id: segment.id,
      segment_version: segment.active_version,
    });
  });
}
