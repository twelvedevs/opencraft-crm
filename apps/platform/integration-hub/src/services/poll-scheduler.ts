import type { Queue } from 'bullmq';

export async function upsertPollJob(
  pollQueue: Queue,
  accountId: string,
): Promise<void> {
  await pollQueue.upsertJobScheduler(
    `poll-ad-spend:${accountId}`,
    { every: 4 * 60 * 60 * 1000 },
    { data: { account_id: accountId } },
  );
}

export async function removePollJob(
  pollQueue: Queue,
  accountId: string,
): Promise<void> {
  await pollQueue.removeJobScheduler(`poll-ad-spend:${accountId}`);
}
