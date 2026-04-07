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

export async function runPoll(db: Knex, eventBus: EventBus): Promise<void> {
  if (isRunning) {
    log.warn('timeout poll already running, skipping');
    return;
  }

  isRunning = true;
  let processed = 0;

  try {
    // Find overdue rows — each row will be re-locked in its own transaction
    const result = await db.raw(
      `SELECT * FROM pipeline_memberships WHERE status = $1 AND timeout_at IS NOT NULL AND timeout_at < NOW() ORDER BY timeout_at ASC LIMIT 100 FOR UPDATE SKIP LOCKED`,
      ['active'],
    );
    const rows = result.rows ?? [];

    if (rows.length === 100) {
      log.warn('timeout poll batch cap hit (100 rows), more may remain');
    }

    for (const row of rows) {
      try {
        const timeoutStage = getTimeoutStage(row.stage);
        const now = new Date();
        const correlationId = randomUUID();
        const exceededBySeconds = Math.floor((now.getTime() - new Date(row.timeout_at).getTime()) / 1000);

        if (timeoutStage !== null) {
          // Stage timeout transition
          await db.transaction(async (trx) => {
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
          });

          // Publish after commit
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
            timeout_at: computeTimeoutAt(timeoutStage, now)?.toISOString() ?? null,
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
          // Archival (e.g. lost with 30d timeout, timeoutStage is null)
          await db.transaction(async (trx) => {
            await trx('pipeline_memberships')
              .where({ id: row.id })
              .update({
                status: 'archived',
                closed_reason: 'archived',
                closed_at: trx.fn.now(),
                timeout_at: null,
                updated_at: trx.fn.now(),
              });
          });

          // Publish after commit — NO history, NO stage_changed, NO stage_timeout
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
        log.error({ err, membership_id: row.id }, 'timeout poll failed for row');
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
