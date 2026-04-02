import { Worker } from 'bullmq';
import type { Pool } from 'pg';
import type { EventBus } from '@ortho/event-bus';
import type { AdSpendSyncedPayload } from '@ortho/types';
import type { Logger } from 'pino';
import { ConnectorRegistry } from '../connectors/registry.js';
import * as accountsRepo from '../repositories/accounts.js';
import * as mappingsRepo from '../repositories/mappings.js';
import { publishAdSpendSynced } from '../services/event-publisher.js';
import type { SpendRecord } from '../connectors/interface.js';

interface PollAdSpendJobData {
  account_id: string;
}

function getTodayAndYesterday(): [string, string] {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return [fmt(today), fmt(yesterday)];
}

export function createPollAdSpendWorker(
  pool: Pool,
  connectorRegistry: typeof ConnectorRegistry,
  bus: EventBus,
  redisConnection: { host: string; port: number },
  log: Logger,
): Worker<PollAdSpendJobData> {
  const worker = new Worker<PollAdSpendJobData>(
    'integration-hub:poll-ad-spend',
    async (job) => {
      const { account_id } = job.data;
      const client = await pool.connect();
      try {
        const account = await accountsRepo.findById(client, account_id);
        if (!account) {
          log.warn({ account_id }, 'poll-ad-spend: account not found, skipping');
          return;
        }

        const connector = connectorRegistry.get(account.platform);
        if (!connector) {
          throw new Error(`Unknown platform: ${account.platform}`);
        }

        const [today, yesterday] = getTodayAndYesterday();

        const todaySpend = await connector.fetchSpend(account, today);
        const yesterdaySpend = await connector.fetchSpend(account, yesterday);

        const mappings = await mappingsRepo.findByAccountId(client, account.id);
        const campaignToLocation = new Map<string, string>();
        for (const m of mappings) {
          campaignToLocation.set(m.campaign_id, m.location_id);
        }

        const publishForDate = async (records: SpendRecord[], date: string) => {
          const mapped = records.filter((r) => campaignToLocation.has(r.campaign_id));
          const byLocation = new Map<string, SpendRecord[]>();
          for (const r of mapped) {
            const locationId = campaignToLocation.get(r.campaign_id)!;
            const group = byLocation.get(locationId) ?? [];
            group.push(r);
            byLocation.set(locationId, group);
          }

          for (const [locationId, locationRecords] of byLocation) {
            const payload: AdSpendSyncedPayload = {
              platform: account.platform,
              location_id: locationId,
              synced_date: date,
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
        };

        await publishForDate(todaySpend, today);
        await publishForDate(yesterdaySpend, yesterday);

        await accountsRepo.setLastPolled(client, account.id);
        log.info({ account_id, platform: account.platform }, 'poll-ad-spend succeeded');
      } catch (err) {
        const client2 = await pool.connect();
        try {
          await accountsRepo.setError(client2, account_id, (err as Error).message);
        } finally {
          client2.release();
        }
        log.error({ account_id, err }, 'poll-ad-spend failed');
        throw err;
      } finally {
        client.release();
      }
    },
    { connection: redisConnection },
  );

  return worker;
}
