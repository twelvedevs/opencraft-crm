import { Worker } from 'bullmq';
import type { Pool } from 'pg';
import type { EventBus } from '@ortho/event-bus';
import type { AdSpendSyncedPayload } from '@ortho/types';
import type { Logger } from 'pino';
import { ConnectorRegistry } from '../connectors/registry.js';
import * as accountsRepo from '../repositories/accounts.js';
import * as mappingsRepo from '../repositories/mappings.js';
import * as backfillJobsRepo from '../repositories/backfill-jobs.js';
import { publishAdSpendSynced } from '../services/event-publisher.js';
import type { SpendRecord } from '../connectors/interface.js';

interface BackfillAdSpendJobData {
  account_id: string;
  backfill_job_id: string;
}

/** Split a date range into 7-day chunks (inclusive). */
function chunkDateRange(from: string, to: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = new Date(from);
  const end = new Date(to);

  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + 6);
    const actualEnd = chunkEnd > end ? end : chunkEnd;

    chunks.push({
      from: cursor.toISOString().slice(0, 10),
      to: actualEnd.toISOString().slice(0, 10),
    });

    cursor = new Date(actualEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  return chunks;
}

export function createBackfillAdSpendWorker(
  pool: Pool,
  connectorRegistry: typeof ConnectorRegistry,
  bus: EventBus,
  redisConnection: { host: string; port: number },
  log: Logger,
): Worker<BackfillAdSpendJobData> {
  const worker = new Worker<BackfillAdSpendJobData>(
    'integration-hub-backfill-ad-spend',
    async (job) => {
      const { account_id, backfill_job_id } = job.data;
      const client = await pool.connect();
      try {
        const backfillJob = await backfillJobsRepo.findById(client, backfill_job_id);
        if (!backfillJob) {
          log.warn({ backfill_job_id }, 'backfill-ad-spend: job not found, skipping');
          return;
        }

        const account = await accountsRepo.findById(client, account_id);
        if (!account) {
          await backfillJobsRepo.setFailed(client, backfill_job_id, 'Account not found');
          log.warn({ account_id, backfill_job_id }, 'backfill-ad-spend: account not found');
          return;
        }

        const connector = connectorRegistry.get(account.platform);
        if (!connector) {
          await backfillJobsRepo.setFailed(client, backfill_job_id, `Unknown platform: ${account.platform}`);
          throw new Error(`Unknown platform: ${account.platform}`);
        }

        const mappings = await mappingsRepo.findByAccountId(client, account.id);
        const campaignToLocation = new Map<string, string>();
        for (const m of mappings) {
          campaignToLocation.set(m.campaign_id, m.location_id);
        }

        const chunks = chunkDateRange(backfillJob.from_date, backfillJob.to_date);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          const records = await connector.fetchSpendRange(account, chunk.from, chunk.to);

          // Filter to mapped campaigns only
          const mapped = records.filter((r) => campaignToLocation.has(r.campaign_id));

          // Group by (location_id, date) — one event per combination per spec §6.1
          const byLocationDate = new Map<string, SpendRecord[]>();
          for (const r of mapped) {
            const locationId = campaignToLocation.get(r.campaign_id)!;
            const key = `${locationId}::${r.date}`;
            const group = byLocationDate.get(key) ?? [];
            group.push(r);
            byLocationDate.set(key, group);
          }

          for (const [key, locationRecords] of byLocationDate) {
            const [locationId, synced_date] = key.split('::') as [string, string];
            const payload: AdSpendSyncedPayload = {
              platform: account.platform,
              location_id: locationId,
              synced_date,
              records: locationRecords.map((r) => ({
                campaign_id: r.campaign_id,
                campaign_name: r.campaign_name,
                spend: r.spend,
                impressions: r.impressions,
                clicks: r.clicks,
              })),
            };
            await publishAdSpendSynced(bus, payload);
          }

          // Update progress using absolute chunk index (safe on BullMQ retry)
          await backfillJobsRepo.updateProgress(client, backfill_job_id, i + 1);
        }

        await backfillJobsRepo.setCompleted(client, backfill_job_id);
        log.info({ account_id, backfill_job_id, platform: account.platform }, 'backfill-ad-spend completed');
      } catch (err) {
        try {
          await backfillJobsRepo.setFailed(client, backfill_job_id, (err as Error).message);
        } catch {
          // ignore secondary error — primary error is re-thrown below
        }
        log.error({ account_id, backfill_job_id, err }, 'backfill-ad-spend failed');
        throw err;
      } finally {
        client.release();
      }
    },
    { connection: redisConnection },
  );

  return worker;
}
