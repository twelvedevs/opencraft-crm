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
