import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { getConnector } from '../connectors/registry.js';
import { decrypt } from '../services/credential-store.js';
import { GoogleAdsClient } from '../connectors/clients/google-ads-client.js';
import { MetaApiClient } from '../connectors/clients/meta-api-client.js';
import * as accountsRepo from '../repositories/accounts.js';
import * as mappingsRepo from '../repositories/mappings.js';

export interface AccountsRoutesOpts {
  pool: Pool;
  encryptionKey: Buffer;
  googleAdsDeveloperToken: string;
}

const MappingsBodySchema = Type.Object({
  mappings: Type.Array(
    Type.Object({
      campaign_id: Type.String(),
      location_id: Type.String(),
    }),
  ),
});

export async function accountsRoutes(
  fastify: FastifyInstance,
  opts: AccountsRoutesOpts,
): Promise<void> {
  const { pool, encryptionKey, googleAdsDeveloperToken } = opts;

  // GET /integrations/accounts
  fastify.get('/integrations/accounts', async (_request, _reply) => {
    const client = await pool.connect();
    try {
      const accounts = await accountsRepo.findAll(client);
      return accounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        account_id: a.account_id,
        account_name: a.account_name,
        status: a.status,
        last_polled_at: a.last_polled_at,
        last_error: a.last_error,
      }));
    } finally {
      client.release();
    }
  });

  // GET /integrations/accounts/:id/campaigns
  fastify.get<{ Params: { id: string } }>(
    '/integrations/accounts/:id/campaigns',
    async (request, reply) => {
      const { id } = request.params;
      const client = await pool.connect();
      try {
        const account = await accountsRepo.findById(client, id);
        if (!account) {
          return reply.code(404).send({ error: 'Account not found' });
        }

        const accessToken = decrypt(account.access_token, encryptionKey);

        let campaigns: { campaign_id: string; campaign_name: string }[];
        if (account.platform === 'google_ads') {
          const adsClient = new GoogleAdsClient(accessToken, account.account_id, googleAdsDeveloperToken);
          campaigns = await adsClient.listCampaigns();
        } else if (account.platform === 'facebook_ads') {
          const metaClient = new MetaApiClient(accessToken, account.account_id);
          campaigns = await metaClient.listCampaigns();
        } else {
          const connector = getConnector(account.platform);
          // Fallback: use fetchSpend for today to discover campaigns
          const today = new Date().toISOString().slice(0, 10);
          const spend = await connector.fetchSpend(account, today);
          campaigns = spend.map((s) => ({
            campaign_id: s.campaign_id,
            campaign_name: s.campaign_name,
          }));
        }

        // Load existing mappings and merge
        const mappings = await mappingsRepo.findByAccountId(client, id);
        const mappingMap = new Map(mappings.map((m) => [m.campaign_id, m.location_id]));

        return campaigns.map((c) => ({
          campaign_id: c.campaign_id,
          campaign_name: c.campaign_name,
          location_id: mappingMap.get(c.campaign_id) ?? null,
        }));
      } finally {
        client.release();
      }
    },
  );

  // PUT /integrations/accounts/:id/mappings
  fastify.put<{ Params: { id: string }; Body: unknown }>(
    '/integrations/accounts/:id/mappings',
    async (request, reply) => {
      const { id } = request.params;

      if (!Value.Check(MappingsBodySchema, request.body)) {
        return reply.code(400).send({ error: 'Invalid request body: expected { mappings: [{ campaign_id, location_id }] }' });
      }

      const body = request.body as { mappings: { campaign_id: string; location_id: string }[] };

      const client = await pool.connect();
      try {
        const account = await accountsRepo.findById(client, id);
        if (!account) {
          return reply.code(404).send({ error: 'Account not found' });
        }

        await mappingsRepo.replaceAll(client, id, body.mappings);
        return reply.code(200).send({ count: body.mappings.length });
      } finally {
        client.release();
      }
    },
  );
}
