import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Connector, IntegrationAccount, LeadEvent, OAuthTokens, SpendRecord } from './interface.js';
import { MetaApiClient, META_GRAPH_API_VERSION } from './clients/meta-api-client.js';
import { decrypt } from '../services/credential-store.js';

export interface MetaConnectorConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  webhookVerifyToken: string;
  encryptionKey: Buffer;
}

export class MetaConnector implements Connector {
  readonly platform = 'facebook_ads';
  private readonly config: MetaConnectorConfig;

  constructor(config: MetaConnectorConfig) {
    this.config = config;
  }

  getAuthorizationUrl(codeChallenge: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'ads_read,leads_retrieval',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });
    return `https://www.facebook.com/dialog/oauth?${params.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens> {
    // Step 1: Exchange code for short-lived token
    const shortRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.config.appId,
          client_secret: this.config.appSecret,
          redirect_uri: this.config.redirectUri,
          code_verifier: codeVerifier,
        }).toString(),
      },
    );

    if (!shortRes.ok) {
      const text = await shortRes.text();
      throw new Error(`Meta OAuth token exchange failed (${shortRes.status}): ${text}`);
    }

    const shortData = (await shortRes.json()) as { access_token: string };

    // Step 2: Exchange short-lived token for long-lived token
    const longParams = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      fb_exchange_token: shortData.access_token,
    });

    const longRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token?${longParams.toString()}`,
    );

    if (!longRes.ok) {
      const text = await longRes.text();
      throw new Error(`Meta long-lived token exchange failed (${longRes.status}): ${text}`);
    }

    const longData = (await longRes.json()) as { access_token: string };

    // Long-lived tokens expire in ~60 days
    const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

    return {
      accessToken: longData.access_token,
      expiresAt: new Date(Date.now() + SIXTY_DAYS_MS),
    };
  }

  async getAccountId(accessToken: string): Promise<string> {
    const params = new URLSearchParams({ fields: 'id', access_token: accessToken });
    const res = await fetch(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/me?${params.toString()}`);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Meta /me failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      throw new Error('Meta /me returned no user ID');
    }

    return data.id;
  }

  async refreshTokens(_account: IntegrationAccount): Promise<OAuthTokens> {
    throw new Error('Meta tokens require manual reconnect');
  }

  async fetchSpend(account: IntegrationAccount, date: string): Promise<SpendRecord[]> {
    const accessToken = decrypt(account.access_token, this.config.encryptionKey);
    const client = new MetaApiClient(accessToken, account.account_id);
    const rows = await client.getInsights(date);
    return rows.map((r) => ({
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      spend: parseFloat(r.spend),
      impressions: parseInt(r.impressions, 10),
      clicks: parseInt(r.clicks, 10),
      date: r.date_start,
    }));
  }

  async fetchSpendRange(account: IntegrationAccount, from: string, to: string): Promise<SpendRecord[]> {
    const accessToken = decrypt(account.access_token, this.config.encryptionKey);
    const client = new MetaApiClient(accessToken, account.account_id);
    const rows = await client.getInsightsRange(from, to);
    return rows.map((r) => ({
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      spend: parseFloat(r.spend),
      impressions: parseInt(r.impressions, 10),
      clicks: parseInt(r.clicks, 10),
      date: r.date_start,
    }));
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): boolean {
    const signature = headers['x-hub-signature-256'];
    if (!signature) return false;

    // Signature format: sha256=<hex>
    const parts = signature.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256') return false;

    const expected = createHmac('sha256', this.config.appSecret)
      .update(rawBody)
      .digest('hex');

    try {
      return timingSafeEqual(
        Buffer.from(parts[1]!, 'hex'),
        Buffer.from(expected, 'hex'),
      );
    } catch {
      return false;
    }
  }

  parseLeadWebhook(payload: unknown): LeadEvent[] {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Unrecognisable Meta lead webhook: payload is not an object');
    }

    const data = payload as { entry?: unknown[] };
    if (!Array.isArray(data.entry)) {
      throw new Error('Unrecognisable Meta lead webhook: missing entry array');
    }

    const events: LeadEvent[] = [];

    for (const entry of data.entry) {
      const entryObj = entry as { changes?: unknown[] };
      if (!Array.isArray(entryObj.changes)) continue;

      for (const change of entryObj.changes) {
        const changeObj = change as {
          field?: string;
          value?: {
            leadgen_id?: string;
            page_id?: string;
            form_id?: string;
            ad_id?: string;
            adgroup_id?: string;
            campaign_id?: string;
          };
        };

        if (changeObj.field !== 'leadgen') continue;
        const value = changeObj.value;
        if (!value) continue;

        events.push({
          external_lead_id: String(value.leadgen_id ?? ''),
          campaign_id: String(value.campaign_id ?? ''),
          ad_set_id: value.adgroup_id ? String(value.adgroup_id) : undefined,
          ad_id: value.ad_id ? String(value.ad_id) : undefined,
          form_id: value.form_id ? String(value.form_id) : undefined,
          fields: {},
        });
      }
    }

    return events;
  }

  verifyChallenge(query: Record<string, string>): string | null {
    if (query['hub.verify_token'] === this.config.webhookVerifyToken) {
      return query['hub.challenge'] ?? null;
    }
    return null;
  }
}
