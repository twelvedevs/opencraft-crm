import type { Queue } from 'bullmq';
import type { Knex } from '../db.js';
import { EmailCampaignJobsRepository } from '../repositories/email-campaign-jobs-repository.js';
import { EmailCampaignRecipientsRepository } from '../repositories/email-campaign-recipients-repository.js';

export async function runCampaignCrashRecovery(db: Knex, campaignQueue: Queue): Promise<void> {
  const jobsRepo = new EmailCampaignJobsRepository(db);
  const recipientsRepo = new EmailCampaignRecipientsRepository(db);

  const processingJobs = await jobsRepo.findProcessingJobs();

  let totalReenqueued = 0;

  for (const job of processingJobs) {
    const pendingRecipients = await recipientsRepo.findPendingByJobId(job.id);
    for (const recipient of pendingRecipients) {
      await campaignQueue.add('send', { recipientId: recipient.id }, { delay: 0 });
      totalReenqueued++;
    }
  }

  console.log(
    `[crash-recovery] scanned ${processingJobs.length} processing job(s), re-enqueued ${totalReenqueued} recipient(s)`,
  );
}
