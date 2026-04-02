// --- OAuth tokens returned by exchangeCode / refreshTokens ---
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

// --- Spend data returned by fetchSpend / fetchSpendRange ---
export interface SpendRecord {
  campaign_id: string;
  campaign_name: string;
  spend: number;
  impressions: number;
  clicks: number;
}

// --- Parsed lead from webhook ---
export interface LeadEvent {
  external_lead_id: string;
  campaign_id: string;
  ad_set_id?: string;
  ad_id?: string;
  form_id?: string;
  fields: Record<string, string>;
}

// --- Connector interface — each platform adapter implements this ---
export interface Connector {
  platform: string;

  // OAuth
  getAuthorizationUrl(codeChallenge: string, state: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens>;
  refreshTokens(account: IntegrationAccount): Promise<OAuthTokens>;

  // Polling
  fetchSpend(account: IntegrationAccount, date: string): Promise<SpendRecord[]>;
  fetchSpendRange(account: IntegrationAccount, from: string, to: string): Promise<SpendRecord[]>;

  // Webhooks
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): boolean;
  parseLeadWebhook(payload: unknown): LeadEvent[];
  verifyChallenge(query: Record<string, string>): string | null;
}

// --- DB row types ---
export interface IntegrationAccount {
  id: string;
  platform: string;
  account_id: string;
  account_name: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: Date | null;
  status: string;
  last_error: string | null;
  last_polled_at: Date | null;
  created_at: Date;
}

export interface CampaignLocationMapping {
  id: string;
  account_id: string;
  campaign_id: string;
  campaign_name: string | null;
  location_id: string;
}

export interface BackfillJob {
  id: string;
  account_id: string;
  status: string;
  from_date: string;
  to_date: string;
  chunks_done: number;
  chunks_total: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}
