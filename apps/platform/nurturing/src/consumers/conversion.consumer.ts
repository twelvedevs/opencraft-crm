import { randomUUID } from 'node:crypto';
import type { EnrollmentsRepository } from '../repositories/enrollments.repo.js';
import type { ConversionsRepository } from '../repositories/conversions.repo.js';
import type { Logger } from 'pino';

interface TrackedCondition {
  field: string;
  op: 'eq' | 'neq' | 'gt' | 'lt' | 'contains';
  value: unknown;
}

interface AbTestConfig {
  enabled: boolean;
  tracked_event?: string;
  tracked_condition?: TrackedCondition;
}

function evaluateCondition(condition: TrackedCondition, payload: Record<string, unknown>): boolean {
  const actual = payload[condition.field];
  switch (condition.op) {
    case 'eq':
      return actual === condition.value;
    case 'neq':
      return actual !== condition.value;
    case 'gt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value;
    case 'lt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value;
    case 'contains':
      return (
        typeof actual === 'string' &&
        typeof condition.value === 'string' &&
        actual.includes(condition.value)
      );
    default:
      return false;
  }
}

export async function processConversionEvent(
  event: unknown,
  deps: {
    enrollmentsRepo: EnrollmentsRepository;
    conversionsRepo: ConversionsRepository;
    logger: Logger;
  },
): Promise<void> {
  try {
    if (
      typeof event !== 'object' ||
      event === null ||
      typeof (event as Record<string, unknown>)['event_type'] !== 'string' ||
      typeof (event as Record<string, unknown>)['entity_id'] !== 'string'
    ) {
      deps.logger.warn({ event }, 'conversion.consumer: malformed event, skipping');
      return;
    }

    const { event_type, entity_id } = event as { event_type: string; entity_id: string };
    const payload = (event as Record<string, unknown>)['payload'] as Record<string, unknown> | undefined ?? {};

    const enrollments = await deps.enrollmentsRepo.findActiveWithAbTestEnabledByEntityId(entity_id);

    for (const enrollment of enrollments) {
      const rawAbTest = typeof enrollment.ab_test === 'string'
        ? (JSON.parse(enrollment.ab_test) as AbTestConfig)
        : (enrollment.ab_test as AbTestConfig);

      if (!rawAbTest?.enabled) continue;
      if (rawAbTest.tracked_event && rawAbTest.tracked_event !== event_type) continue;

      if (rawAbTest.tracked_condition) {
        if (!evaluateCondition(rawAbTest.tracked_condition, payload)) continue;
      }

      const existing = await deps.conversionsRepo.findByEnrollmentId(enrollment.id);
      if (existing) continue;

      await deps.conversionsRepo.insert({
        id: randomUUID(),
        enrollment_id: enrollment.id,
        sequence_id: enrollment.sequence_id,
        ab_variant: enrollment.ab_variant,
        entity_type: enrollment.entity_type,
        entity_id: enrollment.entity_id,
        event_type,
        converted_at: new Date(),
      });

      deps.logger.info(
        { enrollment_id: enrollment.id, entity_id, event_type, ab_variant: enrollment.ab_variant },
        'conversion.consumer: recorded conversion',
      );
    }
  } catch (err) {
    deps.logger.error(err, 'conversion.consumer: unhandled error processing event');
  }
}
