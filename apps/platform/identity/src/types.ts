export interface User {
  id: string;
  provider_user_id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  force_password_reset: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RefreshToken {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export interface ApiKey {
  id: string;
  name: string;
  key_hash: string;
  permissions: string[];
  created_by: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}
