import { createSigner } from 'fast-jwt';
import { randomBytes, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import * as refreshTokenRepo from '../repositories/refresh-token.repo.js';

type DbClient = Pool | PoolClient;

export interface JwtPayload {
  sub: string;
  role: string;
  locations: string[];
  must_change_password: boolean;
}

const IDENTITY_PRIVATE_KEY = process.env['IDENTITY_PRIVATE_KEY'] ?? '';
const IDENTITY_JWKS_KEYS_RAW = process.env['IDENTITY_JWKS_KEYS'] ?? '[]';

const jwksKeys: Array<Record<string, unknown>> = JSON.parse(IDENTITY_JWKS_KEYS_RAW);

const kid = (jwksKeys[0] as { kid?: string })?.kid ?? 'default';

const signer = IDENTITY_PRIVATE_KEY
  ? createSigner({
      algorithm: 'RS256',
      key: IDENTITY_PRIVATE_KEY,
      kid,
      expiresIn: 900_000, // 15 minutes in ms
    })
  : null;

export function signAccessToken(payload: JwtPayload): string {
  if (!signer) {
    throw new Error('IDENTITY_PRIVATE_KEY is not configured');
  }
  return signer(payload);
}

export function getJwks(): { keys: Array<Record<string, unknown>> } {
  return { keys: jwksKeys };
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function issueRefreshToken(client: DbClient, userId: string): Promise<string> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await refreshTokenRepo.createToken(client, {
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });

  return rawToken;
}

export async function rotateRefreshToken(client: DbClient, rawToken: string): Promise<{ rawToken: string; userId: string }> {
  const tokenHash = hashToken(rawToken);

  const row = await refreshTokenRepo.findByHash(client, tokenHash);

  if (!row) {
    const err = new Error('invalid_token') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }

  // Replay detection: if token already revoked, someone reused an old token
  if (row.revoked_at !== null) {
    await refreshTokenRepo.revokeAllForUser(client, row.user_id);
    const err = new Error('session_invalidated') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }

  if (new Date(row.expires_at) < new Date()) {
    const err = new Error('token_expired') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }

  // Revoke old token
  await refreshTokenRepo.revokeToken(client, row.id);

  // Issue new token for same user
  const newRawToken = await issueRefreshToken(client, row.user_id);

  return { rawToken: newRawToken, userId: row.user_id };
}
