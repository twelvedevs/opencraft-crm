import type { Pool } from 'pg';
import type { AuthProvider } from '../providers/auth-provider.interface.js';
import type { User } from '../types.js';
import { validatePassword } from '../lib/password-policy.js';
import * as userRepo from '../repositories/user.repo.js';
import * as refreshTokenRepo from '../repositories/refresh-token.repo.js';

export async function createUser(
  pool: Pool,
  provider: AuthProvider,
  data: {
    email: string;
    name: string;
    role: string;
    password: string;
    locations?: string[];
    created_by?: string;
  },
): Promise<User & { locations: string[] }> {
  const { valid, errors } = validatePassword(data.password);
  if (!valid) {
    const err = new Error('password_policy_violation') as Error & { statusCode: number; details: string[] };
    err.statusCode = 400;
    err.details = errors;
    throw err;
  }

  const { providerUserId } = await provider.createUser(data.email, data.password);

  const user = await userRepo.create(pool, {
    provider_user_id: providerUserId,
    email: data.email,
    name: data.name,
    role: data.role,
    force_password_reset: true,
    created_by: data.created_by ?? null,
  });

  if (data.locations && data.locations.length > 0) {
    await userRepo.setUserLocations(pool, user.id, data.locations);
  }

  const locations = data.locations ?? [];
  return { ...user, locations };
}

export async function getUser(
  pool: Pool,
  id: string,
): Promise<User & { locations: string[] }> {
  const user = await userRepo.findById(pool, id);
  if (!user) {
    const err = new Error('not_found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  const locations = await userRepo.getUserLocations(pool, id);
  return { ...user, locations };
}

export async function listUsers(
  pool: Pool,
  filters: { role?: string; status?: string; cursor?: string; limit?: number },
): Promise<{ rows: User[]; nextCursor: string | null }> {
  return userRepo.listUsers(pool, filters);
}

export async function updateUser(
  pool: Pool,
  provider: AuthProvider,
  id: string,
  data: {
    name?: string;
    role?: string;
    status?: string;
    locations?: string[];
  },
): Promise<User & { locations: string[] }> {
  const existing = await userRepo.findById(pool, id);
  if (!existing) {
    const err = new Error('not_found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  if (data.status === 'active' && existing.status === 'inactive') {
    const err = new Error('reactivation_not_supported') as Error & { statusCode: number };
    err.statusCode = 422;
    throw err;
  }

  if (data.status === 'inactive' && existing.status !== 'inactive') {
    await refreshTokenRepo.revokeAllForUser(pool, id);
    await provider.deactivateUser(existing.provider_user_id);
  }

  const updateData: Partial<Pick<User, 'name' | 'role' | 'status'>> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.role !== undefined) updateData.role = data.role;
  if (data.status !== undefined) updateData.status = data.status;

  const user = Object.keys(updateData).length > 0
    ? await userRepo.update(pool, id, updateData)
    : existing;

  if (data.locations !== undefined) {
    await userRepo.setUserLocations(pool, id, data.locations);
  }

  const locations = data.locations !== undefined
    ? data.locations
    : await userRepo.getUserLocations(pool, id);

  return { ...user, locations };
}

export async function adminResetPassword(
  pool: Pool,
  provider: AuthProvider,
  userId: string,
  newPassword: string,
): Promise<void> {
  const { valid, errors } = validatePassword(newPassword);
  if (!valid) {
    const err = new Error('password_policy_violation') as Error & { statusCode: number; details: string[] };
    err.statusCode = 400;
    err.details = errors;
    throw err;
  }

  const user = await userRepo.findById(pool, userId);
  if (!user) {
    const err = new Error('not_found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  await provider.setPassword(user.provider_user_id, newPassword);
  await userRepo.update(pool, userId, { force_password_reset: true });
}

export async function changeOwnPassword(
  pool: Pool,
  provider: AuthProvider,
  userId: string,
  body: { currentPassword?: string; newPassword: string },
  mustChangePassword: boolean,
): Promise<void> {
  if (!mustChangePassword && !body.currentPassword) {
    const err = new Error('current_password_required') as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const user = await userRepo.findById(pool, userId);
  if (!user) {
    const err = new Error('not_found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  if (!mustChangePassword && body.currentPassword) {
    try {
      await provider.signInWithPassword(user.email, body.currentPassword);
    } catch {
      const err = new Error('invalid_credentials') as Error & { statusCode: number };
      err.statusCode = 401;
      throw err;
    }
  }

  const { valid, errors } = validatePassword(body.newPassword);
  if (!valid) {
    const err = new Error('password_policy_violation') as Error & { statusCode: number; details: string[] };
    err.statusCode = 400;
    err.details = errors;
    throw err;
  }

  await provider.setPassword(user.provider_user_id, body.newPassword);
  await userRepo.update(pool, userId, { force_password_reset: false });
}
