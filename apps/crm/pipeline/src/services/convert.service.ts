import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { findWithLock, setStatus, createMembership, type Membership } from '../repositories/membership.repo.js';
import { insertHistory } from '../repositories/stage-history.repo.js';
import { publishConverted, publishStageChanged } from '../events/publisher.js';

export interface ConversionInput {
  to_pipeline: 'in_treatment' | 'in_retention';
  to_stage: string;
  triggered_by?: string | null;
  reason: 'converted';
  channel: string;
}

export class ConversionError extends Error {
  constructor(
    public statusCode: number,
    public body: Record<string, unknown>,
  ) {
    super(body.error as string);
  }
}

const VALID_CHANNELS = [
  'google_ads', 'facebook', 'website', 'referral_patient', 'referral_doctor',
  'call_tracking', 'walk_in', 'chat', 'google_business', 'import', 'unknown',
];

const ALLOWED_CONVERSIONS: Array<{
  from_pipeline: string;
  from_stage: string;
  to_pipeline: string;
  to_stage: string;
}> = [
  { from_pipeline: 'new_patient', from_stage: 'contract_signed', to_pipeline: 'in_treatment', to_stage: 'new_patient' },
  { from_pipeline: 'in_treatment', from_stage: 'treatment_complete', to_pipeline: 'in_retention', to_stage: 'active_retention' },
];

export async function applyConversion(
  db: Knex,
  eventBus: EventBus,
  membershipId: string,
  data: ConversionInput,
  correlationId: string,
): Promise<Membership> {
  // Validate channel
  if (!VALID_CHANNELS.includes(data.channel)) {
    throw new ConversionError(400, { error: 'invalid_channel', channel: data.channel });
  }

  // Find the allowed conversion pair for the target
  const conversionPair = ALLOWED_CONVERSIONS.find(
    (c) => c.to_pipeline === data.to_pipeline && c.to_stage === data.to_stage,
  );

  if (!conversionPair) {
    throw new ConversionError(422, { error: 'invalid_conversion', to_pipeline: data.to_pipeline, to_stage: data.to_stage });
  }

  let source: Membership | null = null;
  const now = new Date();

  const newMembership = await db.transaction(async (trx) => {
    source = await findWithLock(trx, membershipId);

    if (!source) {
      throw new ConversionError(404, { error: 'not_found' });
    }

    if (source.status !== 'active') {
      throw new ConversionError(409, { error: 'membership_not_active' });
    }

    if (source.pipeline !== conversionPair.from_pipeline || source.stage !== conversionPair.from_stage) {
      throw new ConversionError(422, {
        error: 'invalid_source_stage',
        expected: conversionPair.from_stage,
        actual: source.stage,
      });
    }

    // 1. Close source membership
    await setStatus(trx, membershipId, {
      status: 'closed',
      closed_reason: 'converted',
      closed_at: now,
    });

    // 2. Insert history for source (stage_from and stage_to are both current stage)
    await insertHistory(trx, {
      membership_id: membershipId,
      lead_id: source.lead_id,
      pipeline: source.pipeline,
      stage_from: source.stage,
      stage_to: source.stage,
      override: false,
      triggered_by: data.triggered_by ?? null,
      reason: 'converted',
    });

    // 3. Create target membership
    const target = await createMembership(trx, {
      lead_id: source.lead_id,
      location_id: source.location_id,
      pipeline: data.to_pipeline,
      stage: data.to_stage,
      triggered_by: data.triggered_by ?? null,
      timeout_at: null,
    });

    // 4. Insert history for target
    await insertHistory(trx, {
      membership_id: target.id,
      lead_id: source.lead_id,
      pipeline: data.to_pipeline,
      stage_from: null,
      stage_to: data.to_stage,
      override: false,
      triggered_by: data.triggered_by ?? null,
      reason: 'converted',
    });

    return target;
  });

  // Publish after commit
  await publishConverted(eventBus, correlationId, {
    lead_id: source!.lead_id,
    location_id: source!.location_id,
    from_pipeline: source!.pipeline,
    from_stage: source!.stage,
    to_pipeline: data.to_pipeline,
    to_stage: data.to_stage,
    new_membership_id: newMembership.id,
    channel: data.channel,
    triggered_by: data.triggered_by ?? null,
    converted_at: now.toISOString(),
  });

  await publishStageChanged(eventBus, correlationId, {
    membership_id: newMembership.id,
    lead_id: source!.lead_id,
    location_id: source!.location_id,
    pipeline: data.to_pipeline,
    stage_from: null,
    stage_to: data.to_stage,
    override: false,
    triggered_by: data.triggered_by ?? null,
    reason: 'converted',
    timeout_at: null,
    transitioned_at: now.toISOString(),
    time_in_stage_seconds: null,
    response_time_seconds: null,
  });

  return newMembership;
}
