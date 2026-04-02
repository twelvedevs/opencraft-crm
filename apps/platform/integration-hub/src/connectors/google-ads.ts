import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Connector, IntegrationAccount, LeadEvent, OAuthTokens, SpendRecord } from './interface.js';
import { GoogleAdsClient, GOOGLE_ADS_API_VERSION } from './clients/google-ads-client.js';
import { decrypt } from '../services/credential-store.js';

export interface GoogleAdsConnectorConfig {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  redirectUri: string;
  webhookVerifyToken: string;
  encryptionKey: Buffer;
}

export class GoogleAdsConnector implements Connector {
  readonly platform = 'google_ads';
  private readonly config: GoogleAdsConnectorConfig;

  constructor(config: GoogleAdsConnectorConfig) {
    this.config = config;
  }

  getAuthorizationUrl(codeChallenge: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/adwords',
      access_type: 'offline',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google OAuth token exchange failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
    };
  }

  async getAccountId(accessToken: string): Promise<string> {
    const res = await fetch(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': this.config.developerToken,
        },
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Ads listAccessibleCustomers failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { resourceNames?: string[] };
    const first = data.resourceNames?.[0];
    if (!first) {
      throw new Error('No accessible Google Ads customers found for this account');
    }

    // resourceName format: "customers/1234567890"
    return first.replace('customers/', '');
  }

  async refreshTokens(account: IntegrationAccount): Promise<OAuthTokens> {
    if (!account.refresh_token) {
      throw new Error('No refresh token available for account');
    }

    const refreshToken = decrypt(account.refresh_token, this.config.encryptionKey);

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google OAuth token refresh failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
    };
  }

  async fetchSpend(account: IntegrationAccount, date: string): Promise<SpendRecord[]> {
    const accessToken = decrypt(account.access_token, this.config.encryptionKey);
    const client = new GoogleAdsClient(accessToken, account.account_id, this.config.developerToken);
    const rows = await client.searchCampaignPerformance(date);
    return rows.map((r) => ({
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      spend: r.spend,
      impressions: r.impressions,
      clicks: r.clicks,
      date: r.date,
    }));
  }

  async fetchSpendRange(account: IntegrationAccount, from: string, to: string): Promise<SpendRecord[]> {
    const accessToken = decrypt(account.access_token, this.config.encryptionKey);
    const client = new GoogleAdsClient(accessToken, account.account_id, this.config.developerToken);
    const rows = await client.searchCampaignPerformanceRange(from, to);
    return rows.map((r) => ({
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      spend: r.spend,
      impressions: r.impressions,
      clicks: r.clicks,
      date: r.date,
    }));
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): boolean {
    const signature = headers['x-goog-signature'];
    if (!signature) return false;

    const expected = createHmac('sha256', this.config.webhookVerifyToken)
      .update(rawBody)
      .digest('hex');

    try {
      return timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expected, 'hex'),
      );
    } catch {
      return false;
    }
  }

  parseLeadWebhook(payload: unknown): LeadEvent[] {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Unrecognisable Google Ads lead webhook: payload is not an object');
    }

    const data = payload as Record<string, unknown>;
    const leads = data['leads'] ?? data['lead_form_submit_entries'];

    if (!Array.isArray(leads)) {
      throw new Error('Unrecognisable Google Ads lead webhook: missing leads array');
    }

    return leads.map((lead: Record<string, unknown>) => {
      const fields: Record<string, string> = {};
      const columnData = lead['user_column_data'] ?? lead['column_data'];
      if (Array.isArray(columnData)) {
        for (const col of columnData as { column_name?: string; string_value?: string }[]) {
          if (col.column_name && col.string_value !== undefined) {
            fields[col.column_name] = String(col.string_value);
          }
        }
      }

      return {
        external_lead_id: String(lead['lead_id'] ?? lead['google_lead_id'] ?? ''),
        campaign_id: String(lead['campaign_id'] ?? ''),
        ad_id: lead['ad_id'] ? String(lead['ad_id']) : undefined,
        form_id: lead['form_id'] ? String(lead['form_id']) : undefined,
        fields,
      };
    });
  }

  verifyChallenge(query: Record<string, string>): string | null {
    if (query['hub.verify_token'] === this.config.webhookVerifyToken) {
      return query['hub.challenge'] ?? null;
    }
    return null;
  }
}
