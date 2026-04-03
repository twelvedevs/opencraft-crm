import type { AuthProvider } from './auth-provider.interface.js';
import { Auth0Provider } from './auth0.provider.js';
import { SupabaseProvider } from './supabase.provider.js';

export type { AuthProvider } from './auth-provider.interface.js';

export function createAuthProvider(type: string): AuthProvider {
  switch (type) {
    case 'supabase':
      return new SupabaseProvider(
        process.env['SUPABASE_URL']!,
        process.env['SUPABASE_SERVICE_ROLE_KEY']!,
      );
    case 'auth0':
      return new Auth0Provider(
        process.env['AUTH0_DOMAIN']!,
        process.env['AUTH0_MGMT_CLIENT_ID']!,
        process.env['AUTH0_MGMT_CLIENT_SECRET']!,
      );
    default:
      throw new Error(`Unknown auth provider type: ${type}`);
  }
}
