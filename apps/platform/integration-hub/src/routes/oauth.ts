import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import { getConnector } from '../connectors/registry.js';
import { createState, verifyState } from '../services/oauth-state.js';
import { encrypt } from '../services/credential-store.js';
import * as accountsRepo from '../repositories/accounts.js';
import { upsertPollJob, removePollJob } from '../services/poll-scheduler.js';
import { scheduleTokenRefresh, removeTokenRefreshJob } from '../jobs/refresh-token.js';

export interface OAuthRoutesOpts {
  pool: Pool;
  pollQueue: Queue;
  refreshQueue: Queue;
  encryptionKey: Buffer;
  oauthStateSecret: string;
  redirectUri?: string;
}

export async function oauthRoutes(
  fastify: FastifyInstance,
  opts: OAuthRoutesOpts,
): Promise<void> {
  const { pool, pollQueue, refreshQueue, encryptionKey, oauthStateSecret, redirectUri } = opts;

  // GET /integrations/connect/:platform
  fastify.get<{ Params: { platform: string } }>(
    '/integrations/connect/:platform',
    { schema: { tags: ['OAuth'], summary: 'Start OAuth authorization flow' } as object },
    async (request, reply) => {
      const connector = getConnector(request.params.platform);
      const { state, codeChallenge } = createState(oauthStateSecret);
      const authUrl = connector.getAuthorizationUrl(codeChallenge, state);
      return reply.redirect(authUrl);
    },
  );

  // GET /integrations/oauth/:platform/callback
  fastify.get<{
    Params: { platform: string };
    Querystring: { code: string; state: string };
  }>(
    '/integrations/oauth/:platform/callback',
    { schema: { tags: ['OAuth'], summary: 'OAuth callback handler' } as object },
    async (request, reply) => {
      const { platform } = request.params;
      const { code, state } = request.query;

      let codeVerifier: string;
      try {
        ({ codeVerifier } = verifyState(state, oauthStateSecret));
      } catch {
        return reply.code(400).send({ error: 'Invalid or expired OAuth state' });
      }

      const connector = getConnector(platform);
      const tokens = await connector.exchangeCode(code, codeVerifier);
      const platformAccountId = await connector.getAccountId(tokens.accessToken);

      const encryptedAccess = encrypt(tokens.accessToken, encryptionKey);
      const encryptedRefresh = tokens.refreshToken
        ? encrypt(tokens.refreshToken, encryptionKey)
        : null;

      const client = await pool.connect();
      try {
        const account = await accountsRepo.insert(client, {
          platform,
          account_id: platformAccountId,
          access_token: encryptedAccess,
          refresh_token: encryptedRefresh,
          token_expires_at: tokens.expiresAt ?? null,
        });

        await upsertPollJob(pollQueue, account.id);

        // Schedule token refresh for Google Ads accounts (Meta has no refresh flow)
        if (tokens.expiresAt && platform !== 'facebook_ads') {
          await scheduleTokenRefresh(refreshQueue, account);
        }

        if (redirectUri) {
          return reply.redirect(`${redirectUri}?account_id=${account.id}`);
        }
        return reply.code(200).send({ account_id: account.id });
      } finally {
        client.release();
      }
    },
  );

  // DELETE /integrations/accounts/:id
  fastify.delete<{ Params: { id: string } }>(
    '/integrations/accounts/:id',
    { schema: { tags: ['OAuth'], summary: 'Disconnect integration account' } as object },
    async (request, reply) => {
      const { id } = request.params;

      const client = await pool.connect();
      try {
        const account = await accountsRepo.findById(client, id);
        if (!account) {
          return reply.code(404).send({ error: 'Account not found' });
        }

        await removeTokenRefreshJob(refreshQueue, id);
        await removePollJob(pollQueue, id);
        await accountsRepo.remove(client, id);

        return reply.code(204).send();
      } finally {
        client.release();
      }
    },
  );
}
