import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { isValidTransition, computeTimeoutAt, STAGES } from './state-machine.js';
import { findWithLock, updateStage, type Membership } from '../repositories/membership.repo.js';
import { insertHistory } from '../repositories/stage-history.repo.js';
import {
  publishStageChanged,
  computeTimeInStage,
  computeResponseTime,
} from '../events/publisher.js';

export interface TransitionInput {
  stage: string;
  override: boolean;
  triggered_by?: string | null;
  reason: string;
  timeout_at?: string;
}

export class TransitionError extends Error {
  constructor(
    public statusCode: number,
    public body: Record<string, unknown>,
  ) {
    super(body.error as string);
  }
}

export async function applyTransition(
  db: Knex,
  eventBus: EventBus,
  membershipId: string,
  data: TransitionInput,
  correlationId: string,
): Promise<Membership> {
  // Validate recall_due requires timeout_at
  if (data.stage === 'recall_due' && !data.timeout_at) {
    throw new TransitionError(400, { error: 'timeout_at_required' });
  }

  // Validate override requires triggered_by
  if (data.override && !data.triggered_by) {
    throw new TransitionError(400, { error: 'override_requires_triggered_by' });
  }

  let current: Membership | null = null;
  const now = new Date();

  const updated = await db.transaction(async (trx) => {
    current = await findWithLock(trx, membershipId);

    if (!current) {
      throw new TransitionError(404, { error: 'not_found' });
    }

    if (current.status !== 'active') {
      throw new TransitionError(409, { error: 'membership_not_active' });
    }

    if (!isValidTransition(current.stage, data.stage, data.override)) {
      throw new TransitionError(422, {
        error: 'invalid_transition',
        from: current.stage,
        to: data.stage,
        allowed: STAGES[current.stage]?.allowedTransitions ?? [],
      });
    }

    const callerTimeoutAt = data.timeout_at ? new Date(data.timeout_at) : undefined;
    const timeoutAt = computeTimeoutAt(data.stage, now, callerTimeoutAt);

    const result = await updateStage(trx, membershipId, {
      stage: data.stage,
      timeout_at: timeoutAt,
      override: data.override,
      previous_stage: current.stage,
    });

    await insertHistory(trx, {
      membership_id: membershipId,
      lead_id: current.lead_id,
      pipeline: current.pipeline,
      stage_from: current.stage,
      stage_to: data.stage,
      override: data.override,
      triggered_by: data.triggered_by ?? null,
      reason: data.reason,
    });

    return result;
  });

  // Publish after commit
  const timeInStage = computeTimeInStage(current!.entered_stage_at, now);
  const responseTime =
    data.stage === 'contacted' && current!.stage !== null && data.triggered_by
      ? computeResponseTime(current!.created_at, now)
      : null;

  await publishStageChanged(eventBus, correlationId, {
    membership_id: membershipId,
    lead_id: current!.lead_id,
    location_id: current!.location_id,
    pipeline: current!.pipeline,
    stage_from: current!.stage,
    stage_to: data.stage,
    override: data.override,
    triggered_by: data.triggered_by ?? null,
    reason: data.reason,
    timeout_at: updated.timeout_at ? updated.timeout_at.toISOString() : null,
    transitioned_at: now.toISOString(),
    time_in_stage_seconds: timeInStage,
    response_time_seconds: responseTime,
  });

  return updated;
}
