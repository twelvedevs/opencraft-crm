import type { AuthProvider } from './auth-provider.interface.js';
import { SupabaseProvider } from './supabase.provider.js';

export type { AuthProvider } from './auth-provider.interface.js';

export function createAuthProvider(type: string): AuthProvider {
  switch (type) {
    case 'supabase':
      return new SupabaseProvider(
        process.env['SUPABASE_URL']!,
        process.env['SUPABASE_SERVICE_ROLE_KEY']!,
      );
    default:
      throw new Error(`Unknown auth provider type: ${type}`);
  }
}
