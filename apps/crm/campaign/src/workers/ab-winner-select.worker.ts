import { Worker, type Job } from 'bullmq';
import { createLogger } from '@ortho/logger';
import { bullmqRedis, AB_WINNER_QUEUE } from '../queue/connection.js';
import db from '../db.js';
import { env } from '../env.js';
import * as campaignsRepo from '../repositories/campaigns.repo.js';
import * as sendsRepo from '../repositories/campaign-sends.repo.js';
import * as recipientsRepo from '../repositories/campaign-recipients.repo.js';
import { selectWinner } from '../services/ab-winner.js';

const log = createLogger('ab-winner-select-worker');

export interface ABWinnerJobData {
  campaign_id: string;
}

export async function processJob(job: Job<ABWinnerJobData>): Promise<void> {
  const { campaign_id } = job.data;
  log.info({ campaign_id, jobId: job.id }, 'Processing ab-winner-select job');

  // Step 1: load campaign; guard on status + ab_phase
  const campaign = await campaignsRepo.findById(db, campaign_id);
  if (!campaign) {
    log.warn({ campaign_id }, 'Campaign not found, skipping');
    return;
  }
  if (campaign.status !== 'sending' || campaign.ab_phase !== 'testing') {
    log.info(
      { campaign_id, status: campaign.status, ab_phase: campaign.ab_phase },
      'Campaign not in testing phase, skipping',
    );
    return;
  }

  // Step 2: compute winner using open rates and send counts
  const allSends = await sendsRepo.findAllByCampaignId(db, campaign_id);
  const countA = allSends
    .filter((s) => s.variant === 'A')
    .reduce((sum, s) => sum + s.total_recipients, 0);
  const countB = allSends
    .filter((s) => s.variant === 'B')
    .reduce((sum, s) => sum + s.total_recipients, 0);

  const winner = selectWinner(
    campaign.ab_opens_a,
    countA,
    campaign.ab_opens_b,
    countB,
  );

  log.info(
    { campaign_id, winner, opensA: campaign.ab_opens_a, opensB: campaign.ab_opens_b, countA, countB },
    'A/B winner selected',
  );

  // Step 3: update campaign with winner
  await campaignsRepo.update(db, campaign_id, {
    ab_winner: winner,
    ab_phase: 'complete',
    ab_decision_at: new Date(),
  });

  // Steps 4-5: send winning variant to holdout recipients
  const winningSubject = winner === 'A'
    ? (campaign.ab_variant_a_subject ?? campaign.subject ?? '')
    : (campaign.ab_variant_b_subject ?? campaign.subject ?? '');

  // Fetch all holdout recipients and group by location
  const holdoutRecipients = await db('campaign_recipients')
    .where({ campaign_id, variant: 'holdout' })
    .select('*') as recipientsRepo.CampaignRecipient[];

  const byLocation = new Map<string, recipientsRepo.CampaignRecipient[]>();
  for (const r of holdoutRecipients) {
    const list = byLocation.get(r.location_id) ?? [];
    list.push(r);
    byLocation.set(r.location_id, list);
  }

  const now = new Date();

  for (const [locationId, recipients] of byLocation) {
    const holdoutRef = `${campaign_id}:${locationId}:holdout`;

    // Crash recovery: skip if already sent
    const existing = await sendsRepo.findByEmailJobRef(db, holdoutRef);
    if (existing) continue;

    // POST to Email Service
    const res = await fetch(`${env.EMAIL_SERVICE_URL}/emails/campaigns/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_ref: holdoutRef,
        location_id: locationId,
        template_id: campaign.template_id,
        subject_template: winningSubject,
        recipients: recipients.map((r) => ({
          id: r.lead_id,
          email: r.email,
        })),
        entity_type: 'campaign',
        entity_id: campaign_id,
      }),
    });

    if (res.status === 422) {
      await sendsRepo.insert(db, {
        campaign_id,
        location_id: locationId,
        variant: 'holdout',
        subject_used: winningSubject,
        email_job_id: null,
        email_job_ref: holdoutRef,
        status: 'failed',
        total_recipients: recipients.length,
        sent_count: 0,
        failed_count: 0,
        started_at: null,
        completed_at: now,
      });
      continue;
    }

    if (!res.ok) {
      throw new Error(`Email Service returned ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as { job_id: string };

    // Insert campaign_sends row for holdout
    await sendsRepo.insert(db, {
      campaign_id,
      location_id: locationId,
      variant: 'holdout',
      subject_used: winningSubject,
      email_job_id: body.job_id,
      email_job_ref: holdoutRef,
      status: 'sending',
      total_recipients: recipients.length,
      sent_count: 0,
      failed_count: 0,
      started_at: now,
      completed_at: null,
    });

    // Update holdout recipients sent_at
    await recipientsRepo.updateSentAt(db, campaign_id, 'holdout', locationId, now);
  }

  log.info({ campaign_id, winner }, 'Holdout sends dispatched');
}

export const abWinnerWorker = new Worker<ABWinnerJobData>(
  AB_WINNER_QUEUE,
  processJob,
  { connection: bullmqRedis, concurrency: 1 },
);

abWinnerWorker.on('completed', (job) => {
  log.info({ jobId: job?.id }, 'AB winner select job completed');
});

abWinnerWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err }, 'AB winner select job failed');
});
