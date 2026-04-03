import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock repos and password-policy before importing user.service
vi.mock('../../src/repositories/user.repo.js', () => ({
  findById: vi.fn(),
  findByEmail: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listUsers: vi.fn(),
  getUserLocations: vi.fn(),
  setUserLocations: vi.fn(),
}));

vi.mock('../../src/repositories/refresh-token.repo.js', () => ({
  revokeAllForUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/password-policy.js', () => ({
  validatePassword: vi.fn(),
}));

import { createUser, getUser, updateUser, adminResetPassword, changeOwnPassword } from '../../src/services/user.service.js';
import * as userRepo from '../../src/repositories/user.repo.js';
import * as refreshTokenRepo from '../../src/repositories/refresh-token.repo.js';
import { validatePassword } from '../../src/lib/password-policy.js';
import type { AuthProvider } from '../../src/providers/auth-provider.interface.js';
import type { User } from '../../src/types.js';

const mockPool = {} as any;

const mockUser: User = {
  id: 'user-1',
  provider_user_id: 'prov-1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'call_center_agent',
  status: 'active',
  force_password_reset: true,
  created_by: null,
  created_at: new Date(),
  updated_at: new Date(),
};

function createMockProvider(): AuthProvider {
  return {
    verifyToken: vi.fn().mockResolvedValue({ providerUserId: 'prov-1', email: 'test@example.com' }),
    createUser: vi.fn().mockResolvedValue({ providerUserId: 'prov-1' }),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deactivateUser: vi.fn().mockResolvedValue(undefined),
    signInWithPassword: vi.fn().mockResolvedValue(undefined),
  };
}

describe('user.service', () => {
  let provider: AuthProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createMockProvider();
  });

  describe('createUser', () => {
    it('validates password before calling provider', async () => {
      vi.mocked(validatePassword).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(userRepo.create).mockResolvedValue(mockUser);

      await createUser(mockPool, provider, {
        email: 'test@example.com',
        name: 'Test',
        role: 'call_center_agent',
        password: 'StrongPass1!xy',
      });

      expect(validatePassword).toHaveBeenCalledWith('StrongPass1!xy');
      expect(provider.createUser).toHaveBeenCalledWith('test@example.com', 'StrongPass1!xy');
    });

    it('throws 400 on weak password before any provider call', async () => {
      vi.mocked(validatePassword).mockReturnValue({
        valid: false,
        errors: ['minimum 12 characters required'],
      });

      await expect(
        createUser(mockPool, provider, {
          email: 'test@example.com',
          name: 'Test',
          role: 'call_center_agent',
          password: 'weak',
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'password_policy_violation',
        details: ['minimum 12 characters required'],
      });

      expect(provider.createUser).not.toHaveBeenCalled();
      expect(userRepo.create).not.toHaveBeenCalled();
    });

    it('sets locations when provided', async () => {
      vi.mocked(validatePassword).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(userRepo.create).mockResolvedValue(mockUser);

      const result = await createUser(mockPool, provider, {
        email: 'test@example.com',
        name: 'Test',
        role: 'call_center_agent',
        password: 'StrongPass1!xy',
        locations: ['loc-1', 'loc-2'],
      });

      expect(userRepo.setUserLocations).toHaveBeenCalledWith(mockPool, 'user-1', ['loc-1', 'loc-2']);
      expect(result.locations).toEqual(['loc-1', 'loc-2']);
    });
  });

  describe('getUser', () => {
    it('returns user with locations', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(mockUser);
      vi.mocked(userRepo.getUserLocations).mockResolvedValue(['loc-1']);

      const result = await getUser(mockPool, 'user-1');
      expect(result.id).toBe('user-1');
      expect(result.locations).toEqual(['loc-1']);
    });

    it('throws 404 when user not found', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(null);

      await expect(getUser(mockPool, 'missing')).rejects.toMatchObject({
        statusCode: 404,
        message: 'not_found',
      });
    });
  });

  describe('updateUser', () => {
    it('deactivates user: revokes tokens and calls provider', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(mockUser);
      vi.mocked(userRepo.update).mockResolvedValue({ ...mockUser, status: 'inactive' });

      await updateUser(mockPool, provider, 'user-1', { status: 'inactive' });

      expect(refreshTokenRepo.revokeAllForUser).toHaveBeenCalledWith(mockPool, 'user-1');
      expect(provider.deactivateUser).toHaveBeenCalledWith('prov-1');
      expect(userRepo.update).toHaveBeenCalled();
    });

    it('throws 422 when reactivating inactive user', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue({ ...mockUser, status: 'inactive' });

      await expect(
        updateUser(mockPool, provider, 'user-1', { status: 'active' }),
      ).rejects.toMatchObject({
        statusCode: 422,
        message: 'reactivation_not_supported',
      });
    });

    it('throws 404 when user not found', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(null);

      await expect(
        updateUser(mockPool, provider, 'missing', { name: 'New' }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('adminResetPassword', () => {
    it('validates password policy and calls provider', async () => {
      vi.mocked(validatePassword).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(userRepo.findById).mockResolvedValue(mockUser);
      vi.mocked(userRepo.update).mockResolvedValue({ ...mockUser, force_password_reset: true });

      await adminResetPassword(mockPool, provider, 'user-1', 'NewStrongPass1!');

      expect(provider.setPassword).toHaveBeenCalledWith('prov-1', 'NewStrongPass1!');
      expect(userRepo.update).toHaveBeenCalledWith(mockPool, 'user-1', { force_password_reset: true });
    });

    it('throws 400 on weak password', async () => {
      vi.mocked(validatePassword).mockReturnValue({
        valid: false,
        errors: ['too short'],
      });

      await expect(
        adminResetPassword(mockPool, provider, 'user-1', 'weak'),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(provider.setPassword).not.toHaveBeenCalled();
    });
  });

  describe('changeOwnPassword', () => {
    it('throws 400 when not forced and current_password missing', async () => {
      await expect(
        changeOwnPassword(mockPool, provider, 'user-1', { newPassword: 'New1!' }, false),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'current_password_required',
      });
    });

    it('verifies current password via provider when not forced', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(mockUser);
      vi.mocked(validatePassword).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(userRepo.update).mockResolvedValue({ ...mockUser, force_password_reset: false });

      await changeOwnPassword(mockPool, provider, 'user-1', {
        currentPassword: 'OldPass1!xxxxx',
        newPassword: 'NewStrongPass1!',
      }, false);

      expect(provider.signInWithPassword).toHaveBeenCalledWith('test@example.com', 'OldPass1!xxxxx');
      expect(provider.setPassword).toHaveBeenCalledWith('prov-1', 'NewStrongPass1!');
      expect(userRepo.update).toHaveBeenCalledWith(mockPool, 'user-1', { force_password_reset: false });
    });

    it('skips current password check when must_change_password is true', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(mockUser);
      vi.mocked(validatePassword).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(userRepo.update).mockResolvedValue({ ...mockUser, force_password_reset: false });

      await changeOwnPassword(mockPool, provider, 'user-1', {
        newPassword: 'NewStrongPass1!',
      }, true);

      expect(provider.signInWithPassword).not.toHaveBeenCalled();
      expect(provider.setPassword).toHaveBeenCalled();
    });

    it('throws 401 when current password is wrong', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(mockUser);
      (provider.signInWithPassword as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('wrong'));

      await expect(
        changeOwnPassword(mockPool, provider, 'user-1', {
          currentPassword: 'WrongPass1!xxxx',
          newPassword: 'NewStrongPass1!',
        }, false),
      ).rejects.toMatchObject({ statusCode: 401, message: 'invalid_credentials' });
    });
  });
});
