import { Worker } from 'bullmq';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { ConnectorRegistry } from '../connectors/registry.js';
import * as accountsRepo from '../repositories/accounts.js';
import { encrypt } from '../services/credential-store.js';

interface RefreshTokenJobData {
  account_id: string;
}

export function createRefreshTokenWorker(
  pool: Pool,
  connectorRegistry: typeof ConnectorRegistry,
  credentialEncryptionKey: Buffer,
  refreshQueue: import('bullmq').Queue,
  redisConnection: { host: string; port: number },
  log: Logger,
): Worker<RefreshTokenJobData> {
  const worker = new Worker<RefreshTokenJobData>(
    'integration-hub-refresh-token',
    async (job) => {
      const { account_id } = job.data;
      const client = await pool.connect();
      try {
        const account = await accountsRepo.findById(client, account_id);
        if (!account) {
          log.warn({ account_id }, 'refresh-token: account not found, skipping');
          return;
        }

        const connector = connectorRegistry.get(account.platform);
        if (!connector) {
          throw new Error(`Unknown platform: ${account.platform}`);
        }

        const tokens = await connector.refreshTokens(account);

        const encryptedAccess = encrypt(tokens.accessToken, credentialEncryptionKey);
        const encryptedRefresh = tokens.refreshToken
          ? encrypt(tokens.refreshToken, credentialEncryptionKey)
          : undefined;

        await accountsRepo.updateTokens(client, account.id, {
          access_token: encryptedAccess,
          refresh_token: encryptedRefresh,
          token_expires_at: tokens.expiresAt ?? null,
        });

        // Schedule next refresh 30 minutes before expiry
        if (tokens.expiresAt) {
          const delay = tokens.expiresAt.getTime() - Date.now() - 30 * 60 * 1000;
          if (delay > 0) {
            await scheduleTokenRefresh(refreshQueue, { ...account, token_expires_at: tokens.expiresAt });
          }
        }

        log.info({ account_id, platform: account.platform }, 'refresh-token succeeded');
      } catch (err) {
        try {
          await accountsRepo.setError(client, account_id, (err as Error).message);
        } catch {
          // ignore secondary error — primary error is re-thrown below
        }
        log.error({ account_id, err }, 'refresh-token failed');
        throw err;
      } finally {
        client.release();
      }
    },
    { connection: redisConnection },
  );

  return worker;
}

export async function scheduleTokenRefresh(
  refreshQueue: import('bullmq').Queue,
  account: { id: string; token_expires_at: Date | null },
): Promise<void> {
  if (!account.token_expires_at) return;

  const delay = account.token_expires_at.getTime() - Date.now() - 30 * 60 * 1000;
  if (delay <= 0) return;

  const jobId = `refresh-token:${account.id}`;

  // Remove existing job if present
  const existing = await refreshQueue.getJob(jobId);
  if (existing) {
    await existing.remove();
  }

  await refreshQueue.add('refresh-token', { account_id: account.id }, {
    jobId,
    delay,
  });
}

export async function removeTokenRefreshJob(
  refreshQueue: import('bullmq').Queue,
  accountId: string,
): Promise<void> {
  const jobId = `refresh-token:${accountId}`;
  const job = await refreshQueue.getJob(jobId);
  if (job) {
    await job.remove();
  }
}
