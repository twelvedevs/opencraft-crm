import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Knex } from '../db.js';

export function createCleanupSweepWorker(
  connection: Redis,
  db: Knex,
): Worker {
  const queue = new Queue('audience-snapshot-cleanup-sweep', { connection });

  // Add repeatable job (idempotent — BullMQ deduplicates by key)
  void queue.add('sweep', {}, { repeat: { every: 60 * 60 * 1000 } });

  const worker = new Worker(
    'audience-snapshot-cleanup-sweep',
    async (_job: Job) => {
      const result = await db('audience_snapshots')
        .whereRaw('expires_at < NOW()')
        .del();
      console.info(JSON.stringify({ msg: 'snapshot-cleanup-sweep', deletedCount: result }));
    },
    { connection, autorun: false },
  );

  return worker;
}
