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
