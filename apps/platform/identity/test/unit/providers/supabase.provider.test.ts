import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @supabase/supabase-js
const mockAuth = {
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  admin: {
    createUser: vi.fn(),
    updateUserById: vi.fn(),
  },
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: mockAuth })),
}));

import { SupabaseProvider } from '../../../src/providers/supabase.provider.js';

describe('SupabaseProvider', () => {
  let provider: SupabaseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SupabaseProvider('https://test.supabase.co', 'service-role-key');
  });

  describe('verifyToken', () => {
    it('returns providerUserId and email on success', async () => {
      mockAuth.getUser.mockResolvedValue({
        data: { user: { id: 'supa-user-1', email: 'user@test.com' } },
        error: null,
      });

      const result = await provider.verifyToken('valid-token');
      expect(result).toEqual({ providerUserId: 'supa-user-1', email: 'user@test.com' });
      expect(mockAuth.getUser).toHaveBeenCalledWith('valid-token');
    });

    it('throws on invalid token', async () => {
      mockAuth.getUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid token' },
      });

      await expect(provider.verifyToken('bad-token')).rejects.toThrow('Invalid token');
    });
  });

  describe('createUser', () => {
    it('calls admin.createUser with correct params', async () => {
      mockAuth.admin.createUser.mockResolvedValue({
        data: { user: { id: 'supa-new-1' } },
        error: null,
      });

      const result = await provider.createUser('new@test.com', 'password123');
      expect(result).toEqual({ providerUserId: 'supa-new-1' });
      expect(mockAuth.admin.createUser).toHaveBeenCalledWith({
        email: 'new@test.com',
        password: 'password123',
        email_confirm: true,
      });
    });

    it('throws on error', async () => {
      mockAuth.admin.createUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'Duplicate email' },
      });

      await expect(provider.createUser('dup@test.com', 'pass')).rejects.toThrow('Duplicate email');
    });
  });

  describe('setPassword', () => {
    it('calls admin.updateUserById with password', async () => {
      mockAuth.admin.updateUserById.mockResolvedValue({ error: null });

      await provider.setPassword('supa-user-1', 'new-password');
      expect(mockAuth.admin.updateUserById).toHaveBeenCalledWith('supa-user-1', { password: 'new-password' });
    });

    it('throws on error', async () => {
      mockAuth.admin.updateUserById.mockResolvedValue({ error: { message: 'Failed' } });

      await expect(provider.setPassword('supa-user-1', 'pass')).rejects.toThrow('Failed');
    });
  });

  describe('deactivateUser', () => {
    it('calls admin.updateUserById with ban_duration', async () => {
      mockAuth.admin.updateUserById.mockResolvedValue({ error: null });

      await provider.deactivateUser('supa-user-1');
      expect(mockAuth.admin.updateUserById).toHaveBeenCalledWith('supa-user-1', {
        ban_duration: '87600h',
      });
    });
  });

  describe('signInWithPassword', () => {
    it('calls supabase.auth.signInWithPassword', async () => {
      mockAuth.signInWithPassword.mockResolvedValue({ error: null });

      await provider.signInWithPassword('user@test.com', 'password');
      expect(mockAuth.signInWithPassword).toHaveBeenCalledWith({
        email: 'user@test.com',
        password: 'password',
      });
    });

    it('throws on error', async () => {
      mockAuth.signInWithPassword.mockResolvedValue({ error: { message: 'Invalid creds' } });

      await expect(provider.signInWithPassword('user@test.com', 'wrong')).rejects.toThrow('Invalid creds');
    });
  });
});
