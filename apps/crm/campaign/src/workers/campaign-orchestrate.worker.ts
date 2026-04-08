import { Worker, type Job } from 'bullmq';
import { createLogger } from '@ortho/logger';
import { bullmqRedis, ORCHESTRATE_QUEUE } from '../queue/connection.js';
import db from '../db.js';
import { env } from '../env.js';
import * as campaignsRepo from '../repositories/campaigns.repo.js';
import { insertEvent } from '../repositories/campaign-events.repo.js';
import { resolveAudience } from '../services/audience-resolver.js';
import { orchestrateNonAB } from '../services/send-orchestrator.js';

const log = createLogger('campaign-orchestrate-worker');

export interface OrchestrateJobData {
  campaign_id: string;
}

async function processJob(job: Job<OrchestrateJobData>): Promise<void> {
  const { campaign_id } = job.data;
  log.info({ campaign_id, jobId: job.id }, 'Processing orchestrate job');

  // Step 1 — status guard: if not scheduled/sending, ACK and return
  const campaign = await campaignsRepo.findById(db, campaign_id);
  if (!campaign) {
    log.warn({ campaign_id }, 'Campaign not found, skipping');
    return;
  }
  if (campaign.status !== 'scheduled' && campaign.status !== 'sending') {
    log.info(
      { campaign_id, status: campaign.status },
      'Campaign not in schedulable status, skipping',
    );
    return;
  }

  // Step 2 — status transition: set sending + sent_at (preserve existing sent_at on retry)
  await db('campaigns')
    .where({ id: campaign_id })
    .whereIn('status', ['scheduled', 'sending'])
    .update({
      status: 'sending',
      sent_at: db.raw('COALESCE(sent_at, now())'),
      updated_at: db.fn.now(),
    });

  // Step 3 — snapshot expiry check
  if (campaign.audience_snapshot_id) {
    const snapshotUrl = `${env.AUDIENCE_ENGINE_URL}/audiences/snapshots/${campaign.audience_snapshot_id}`;
    const res = await fetch(snapshotUrl);
    if (res.status === 404) {
      await campaignsRepo.update(db, campaign_id, {
        audience_snapshot_id: null,
      });
      campaign.audience_snapshot_id = null;
    }
  }

  // Steps 4-7 — audience resolution
  const { snapshotId, groupedByLocation } = await resolveAudience(
    db,
    campaign,
    env,
  );
  await campaignsRepo.update(db, campaign_id, {
    audience_snapshot_id: snapshotId,
  });

  // Step 8 — empty audience guard
  if (groupedByLocation.size === 0) {
    await campaignsRepo.update(db, campaign_id, {
      status: 'failed',
      completed_at: new Date(),
    });
    await insertEvent(db, {
      campaign_id,
      from_status: 'sending',
      to_status: 'failed',
      actor_id: null,
      comment: 'empty_audience',
    });
    log.info({ campaign_id }, 'Empty audience, campaign marked as failed');
    return;
  }

  // Steps 9-11 — non-A/B send orchestration
  await orchestrateNonAB(db, campaign, groupedByLocation, env);
  log.info(
    { campaign_id, locationCount: groupedByLocation.size },
    'Orchestration complete',
  );
}

export const orchestrateWorker = new Worker<OrchestrateJobData>(
  ORCHESTRATE_QUEUE,
  processJob,
  { connection: bullmqRedis, concurrency: 1 },
);

orchestrateWorker.on('completed', (job) => {
  log.info({ jobId: job?.id }, 'Orchestrate job completed');
});

orchestrateWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err }, 'Orchestrate job failed');
});
