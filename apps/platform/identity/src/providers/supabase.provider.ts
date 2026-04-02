import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthProvider } from './auth-provider.interface.js';

export class SupabaseProvider implements AuthProvider {
  private supabase: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceRoleKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
  }

  async verifyToken(token: string): Promise<{ providerUserId: string; email: string }> {
    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) {
      throw new Error(error?.message ?? 'Invalid token');
    }
    return { providerUserId: data.user.id, email: data.user.email! };
  }

  async createUser(email: string, password: string): Promise<{ providerUserId: string }> {
    const { data, error } = await this.supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(error?.message ?? 'Failed to create user');
    }
    return { providerUserId: data.user.id };
  }

  async setPassword(providerUserId: string, password: string): Promise<void> {
    const { error } = await this.supabase.auth.admin.updateUserById(providerUserId, { password });
    if (error) {
      throw new Error(error.message);
    }
  }

  async deactivateUser(providerUserId: string): Promise<void> {
    const { error } = await this.supabase.auth.admin.updateUserById(providerUserId, {
      ban_duration: '87600h',
    });
    if (error) {
      throw new Error(error.message);
    }
  }

  async signInWithPassword(email: string, password: string): Promise<void> {
    const { error } = await this.supabase.auth.signInWithPassword({ email, password });
    if (error) {
      throw new Error(error.message);
    }
  }
}
