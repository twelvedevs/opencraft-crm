import { Cron } from 'croner';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@ortho/logger';
import { env } from '../env.js';
import { getTimeoutStage, computeTimeoutAt } from '../services/state-machine.js';
import { updateStage } from '../repositories/membership.repo.js';
import { insertHistory } from '../repositories/stage-history.repo.js';
import {
  publishStageChanged,
  publishStageTimeout,
  publishArchived,
  computeTimeInStage,
} from '../events/publisher.js';

const log = createLogger('crm-pipeline');

let isRunning = false;

export function resetIsRunning(): void {
  isRunning = false;
}

type PollOutcome =
  | { type: 'skipped' }
  | {
      type: 'transition';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row: any;
      timeoutStage: string;
      timeoutAt: Date | null;
      exceededBySeconds: number;
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { type: 'archive'; row: any; exceededBySeconds: number };

export async function runPoll(db: Knex, eventBus: EventBus): Promise<void> {
  if (isRunning) {
    log.warn('timeout poll already running, skipping');
    return;
  }

  isRunning = true;
  let processed = 0;

  try {
    // Collect candidate IDs without locking — row locks are acquired per-row inside
    // individual transactions using FOR UPDATE SKIP LOCKED, which is the correct
    // pattern for multi-instance safety: the lock must be held through the write.
    const result = await db.raw(
      `SELECT id FROM pipeline_memberships WHERE status = $1 AND timeout_at IS NOT NULL AND timeout_at < NOW() ORDER BY timeout_at ASC LIMIT 100`,
      ['active'],
    );
    const candidateIds: string[] = (result.rows ?? []).map((r: { id: string }) => r.id);

    if (candidateIds.length === 100) {
      log.warn('timeout poll batch cap hit (100 rows), more may remain');
    }

    for (const candidateId of candidateIds) {
      const now = new Date();
      const correlationId = randomUUID();

      try {
        const outcome: PollOutcome = await db.transaction(async (trx) => {
          // Re-acquire with SKIP LOCKED inside the transaction so the lock is held
          // throughout the UPDATE + INSERT, preventing double-processing by concurrent
          // instances that may have also selected this candidate ID.
          const lockResult = await trx.raw(
            `SELECT * FROM pipeline_memberships WHERE id = $1 FOR UPDATE SKIP LOCKED`,
            [candidateId],
          );
          const row = lockResult.rows[0];
          if (!row) return { type: 'skipped' };

          const exceededBySeconds = Math.floor(
            (now.getTime() - new Date(row.timeout_at).getTime()) / 1000,
          );
          const timeoutStage = getTimeoutStage(row.stage);

          if (timeoutStage !== null) {
            const timeoutAt = computeTimeoutAt(timeoutStage, now);

            await updateStage(trx, row.id, {
              stage: timeoutStage,
              timeout_at: timeoutAt,
              override: false,
              previous_stage: row.stage,
            });

            await insertHistory(trx, {
              membership_id: row.id,
              lead_id: row.lead_id,
              pipeline: row.pipeline,
              stage_from: row.stage,
              stage_to: timeoutStage,
              override: false,
              triggered_by: null,
              reason: 'timeout',
            });

            return { type: 'transition', row, timeoutStage, timeoutAt, exceededBySeconds };
          } else {
            // Archival: lost stage timed out after 30 days — no stage transition,
            // no history row, dedicated lead.archived event instead of lead.stage_changed.
            await trx('pipeline_memberships')
              .where({ id: row.id })
              .update({
                status: 'archived',
                closed_reason: 'archived',
                closed_at: trx.fn.now(),
                timeout_at: null,
                updated_at: trx.fn.now(),
              });

            return { type: 'archive', row, exceededBySeconds };
          }
        });

        if (outcome.type === 'skipped') continue;

        // Post-commit event publishing
        if (outcome.type === 'transition') {
          const { row, timeoutStage, timeoutAt, exceededBySeconds } = outcome;
          const timeInStage = computeTimeInStage(new Date(row.entered_stage_at), now);

          await publishStageChanged(eventBus, correlationId, {
            membership_id: row.id,
            lead_id: row.lead_id,
            location_id: row.location_id,
            pipeline: row.pipeline,
            stage_from: row.stage,
            stage_to: timeoutStage,
            override: false,
            triggered_by: null,
            reason: 'timeout',
            timeout_at: timeoutAt?.toISOString() ?? null,
            transitioned_at: now.toISOString(),
            time_in_stage_seconds: timeInStage,
            response_time_seconds: null,
          });

          await publishStageTimeout(eventBus, correlationId, {
            membership_id: row.id,
            lead_id: row.lead_id,
            location_id: row.location_id,
            pipeline: row.pipeline,
            timed_out_stage: row.stage,
            new_stage: timeoutStage,
            timed_out_at: now.toISOString(),
            exceeded_by_seconds: exceededBySeconds,
          });
        } else {
          const { row } = outcome;

          await publishArchived(eventBus, correlationId, {
            membership_id: row.id,
            lead_id: row.lead_id,
            location_id: row.location_id,
            pipeline: row.pipeline,
            archived_at: now.toISOString(),
          });
        }

        processed++;
      } catch (err) {
        log.error({ err, membership_id: candidateId }, 'timeout poll failed for row');
      }
    }

    log.info({ processed }, 'timeout poll completed');
  } finally {
    isRunning = false;
  }
}

export function createTimeoutPollJob(
  db: Knex,
  eventBus: EventBus,
): { start(): void; stop(): void } {
  let cronTask: Cron | null = null;

  return {
    start() {
      if (env.TIMEOUT_POLL_ENABLED === 'false') {
        log.info('timeout poll disabled');
        return;
      }

      cronTask = new Cron('*/15 * * * *', { protect: true }, async () => {
        await runPoll(db, eventBus);
      });
    },
    stop() {
      if (cronTask) {
        cronTask.stop();
      }
    },
  };
}
