import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Knex } from '../db.js';

interface CleanupJobData {
  snapshotId: string;
}

export function createSnapshotCleanupQueue(connection: Redis): Queue<CleanupJobData> {
  return new Queue<CleanupJobData>('audience-snapshot-cleanup', { connection });
}

export async function enqueueSnapshotCleanup(
  queue: Queue<CleanupJobData>,
  snapshotId: string,
  delayMs: number,
): Promise<void> {
  await queue.add('cleanup', { snapshotId }, { delay: delayMs, attempts: 1 });
}

export function createSnapshotCleanupWorker(
  connection: Redis,
  db: Knex,
): Worker<CleanupJobData> {
  const worker = new Worker<CleanupJobData>(
    'audience-snapshot-cleanup',
    async (job: Job<CleanupJobData>) => {
      const { snapshotId } = job.data;
      const result = await db('audience_snapshots').where({ id: snapshotId }).del();
      console.info(JSON.stringify({ msg: 'snapshot-cleanup', snapshotId, deleted: result > 0 }));
    },
    { connection, autorun: false },
  );

  return worker;
}
