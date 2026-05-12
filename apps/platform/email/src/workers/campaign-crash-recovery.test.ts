import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Queue } from 'bullmq';
import type { Knex } from '../db.js';

vi.mock('../repositories/email-campaign-jobs-repository.js', () => ({
  EmailCampaignJobsRepository: vi.fn(),
}));
vi.mock('../repositories/email-campaign-recipients-repository.js', () => ({
  EmailCampaignRecipientsRepository: vi.fn(),
}));

describe('runCampaignCrashRecovery', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockJobsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRecipientsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockQueue: any;

  beforeEach(async () => {
    const { EmailCampaignJobsRepository } = await import(
      '../repositories/email-campaign-jobs-repository.js'
    );
    const { EmailCampaignRecipientsRepository } = await import(
      '../repositories/email-campaign-recipients-repository.js'
    );

    mockJobsRepo = { findProcessingJobs: vi.fn() };
    vi.mocked(EmailCampaignJobsRepository).mockImplementation(() => mockJobsRepo);

    mockRecipientsRepo = { findPendingByJobId: vi.fn() };
    vi.mocked(EmailCampaignRecipientsRepository).mockImplementation(() => mockRecipientsRepo);

    mockQueue = { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;
  });

  it('no processing jobs: queue.add never called', async () => {
    mockJobsRepo.findProcessingJobs.mockResolvedValue([]);

    const { runCampaignCrashRecovery } = await import('./campaign-crash-recovery.js');
    await runCampaignCrashRecovery({} as Knex, mockQueue);

    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it('one processing job with two pending recipients: queue.add called twice with correct recipientIds', async () => {
    mockJobsRepo.findProcessingJobs.mockResolvedValue([{ id: 'job-1' }]);
    mockRecipientsRepo.findPendingByJobId.mockResolvedValue([
      { id: 'rec-1' },
      { id: 'rec-2' },
    ]);

    const { runCampaignCrashRecovery } = await import('./campaign-crash-recovery.js');
    await runCampaignCrashRecovery({} as Knex, mockQueue);

    expect(mockQueue.add).toHaveBeenCalledTimes(2);
    expect(mockQueue.add).toHaveBeenCalledWith('send', { recipientId: 'rec-1' }, { delay: 0 });
    expect(mockQueue.add).toHaveBeenCalledWith('send', { recipientId: 'rec-2' }, { delay: 0 });
  });

  it('multiple processing jobs: recipients from all jobs re-enqueued', async () => {
    mockJobsRepo.findProcessingJobs.mockResolvedValue([{ id: 'job-1' }, { id: 'job-2' }]);
    mockRecipientsRepo.findPendingByJobId
      .mockResolvedValueOnce([{ id: 'rec-1' }])
      .mockResolvedValueOnce([{ id: 'rec-2' }, { id: 'rec-3' }]);

    const { runCampaignCrashRecovery } = await import('./campaign-crash-recovery.js');
    await runCampaignCrashRecovery({} as Knex, mockQueue);

    expect(mockQueue.add).toHaveBeenCalledTimes(3);
    expect(mockQueue.add).toHaveBeenCalledWith('send', { recipientId: 'rec-1' }, { delay: 0 });
    expect(mockQueue.add).toHaveBeenCalledWith('send', { recipientId: 'rec-2' }, { delay: 0 });
    expect(mockQueue.add).toHaveBeenCalledWith('send', { recipientId: 'rec-3' }, { delay: 0 });
  });

  it('processing job with zero pending recipients: queue.add not called for that job', async () => {
    mockJobsRepo.findProcessingJobs.mockResolvedValue([{ id: 'job-1' }]);
    mockRecipientsRepo.findPendingByJobId.mockResolvedValue([]);

    const { runCampaignCrashRecovery } = await import('./campaign-crash-recovery.js');
    await runCampaignCrashRecovery({} as Knex, mockQueue);

    expect(mockQueue.add).not.toHaveBeenCalled();
  });
});
