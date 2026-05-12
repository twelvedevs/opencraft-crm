import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { env } from '../env.js';

function padTwo(n: number): string {
  return String(n).padStart(2, '0');
}

function formatPartitionName(year: number, month: number): string {
  return `analytics_events_${year}_${padTwo(month)}`;
}

function formatDate(year: number, month: number): string {
  return `${year}-${padTwo(month)}-01`;
}

async function runPartitionMaintenance(pool: Pool): Promise<void> {
  const now = new Date();

  // Next month — the partition to create
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextYear = nextMonth.getFullYear();
  const nextMon = nextMonth.getMonth() + 1;

  // Month after next — exclusive upper bound for the partition range
  const monthAfterNext = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  const afterYear = monthAfterNext.getFullYear();
  const afterMon = monthAfterNext.getMonth() + 1;

  // 25 months ago — the partition to drop
  const old = new Date(now.getFullYear(), now.getMonth() - 25, 1);
  const oldYear = old.getFullYear();
  const oldMon = old.getMonth() + 1;

  const newPartition = formatPartitionName(nextYear, nextMon);
  const fromDate = formatDate(nextYear, nextMon);
  const toDate = formatDate(afterYear, afterMon);
  const oldPartition = formatPartitionName(oldYear, oldMon);

  const client = await pool.connect();
  try {
    // 1. Create next month partition (idempotent — IF NOT EXISTS)
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.${newPartition}
        PARTITION OF platform_analytics.analytics_events
        FOR VALUES FROM ('${fromDate}') TO ('${toDate}')
    `);

    // 2. Move any rows from the default partition that belong in the new partition.
    //    DELETE from default then re-insert via the parent table — PostgreSQL routes
    //    them to the correct named partition based on occurred_at range.
    await client.query(`
      WITH moved AS (
        DELETE FROM platform_analytics.analytics_events_default
        WHERE occurred_at >= '${fromDate}' AND occurred_at < '${toDate}'
        RETURNING *
      )
      INSERT INTO platform_analytics.analytics_events SELECT * FROM moved
    `);

    // 3. Drop the partition from 25 months ago (metadata-only op — no row scans)
    await client.query(`
      DROP TABLE IF EXISTS platform_analytics.${oldPartition}
    `);
  } finally {
    client.release();
  }
}

export function registerPartitionMaintenanceJob(queue: Queue, pool: Pool): void {
  // Schedule the repeatable job: 00:01 on the 1st of each month
  void queue
    .add('partition-maintenance', {}, {
      repeat: { pattern: '1 0 1 * *' },
      jobId: 'partition-maintenance-cron',
    })
    .catch((err: Error) =>
      console.error(`[partition-maintenance] failed to schedule: ${err.message}`),
    );

  // Worker uses a dedicated connection — BullMQ Workers require blocking Redis commands
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const worker = new Worker(
    queue.name,
    async (job) => {
      if (job.name !== 'partition-maintenance') return;
      await runPartitionMaintenance(pool);
    },
    { connection },
  );

  worker.on('failed', (_job, err) => {
    console.error(`[partition-maintenance] job failed: ${err.message}`);
  });
}
