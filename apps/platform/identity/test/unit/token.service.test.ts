import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { createVerifier } from 'fast-jwt';

// Generate RSA key pair for tests
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const jwk = createPublicKey(publicKey).export({ format: 'jwk' });
const jwksKeys = [{ ...jwk, kid: 'test-kid-1', use: 'sig', alg: 'RS256' }];

// Mock the refresh-token repo (hoisted by vitest)
vi.mock('../../src/repositories/refresh-token.repo.js', () => ({
  createToken: vi.fn().mockResolvedValue({
    id: 'rt-1',
    user_id: 'user-1',
    token_hash: 'hash',
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    revoked_at: null,
    created_at: new Date(),
  }),
  findByHash: vi.fn(),
  revokeToken: vi.fn().mockResolvedValue(undefined),
  revokeAllForUser: vi.fn().mockResolvedValue(undefined),
}));

// Use dynamic import so env vars are set before module loads
let signAccessToken: typeof import('../../src/services/token.service.js').signAccessToken;
let getJwks: typeof import('../../src/services/token.service.js').getJwks;
let issueRefreshToken: typeof import('../../src/services/token.service.js').issueRefreshToken;
let rotateRefreshToken: typeof import('../../src/services/token.service.js').rotateRefreshToken;
let refreshTokenRepo: typeof import('../../src/repositories/refresh-token.repo.js');

const mockPool = {} as any;

beforeAll(async () => {
  process.env['IDENTITY_PRIVATE_KEY'] = privateKey;
  process.env['IDENTITY_JWKS_KEYS'] = JSON.stringify(jwksKeys);

  const mod = await import('../../src/services/token.service.js');
  signAccessToken = mod.signAccessToken;
  getJwks = mod.getJwks;
  issueRefreshToken = mod.issueRefreshToken;
  rotateRefreshToken = mod.rotateRefreshToken;

  refreshTokenRepo = await import('../../src/repositories/refresh-token.repo.js');
});

describe('token.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('signAccessToken', () => {
    it('signs a JWT that can be verified with the public key', () => {
      const payload = {
        sub: 'user-1',
        role: 'super_admin',
        locations: ['loc-1'],
        must_change_password: false,
      };

      const token = signAccessToken(payload);
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');

      const verifier = createVerifier({ key: publicKey });
      const decoded = verifier(token) as Record<string, unknown>;
      expect(decoded.sub).toBe('user-1');
      expect(decoded.role).toBe('super_admin');
      expect(decoded.locations).toEqual(['loc-1']);
      expect(decoded.must_change_password).toBe(false);
    });

    it('includes kid header in the JWT', () => {
      const payload = {
        sub: 'user-1',
        role: 'super_admin',
        locations: [],
        must_change_password: false,
      };

      const token = signAccessToken(payload);
      const headerB64 = token.split('.')[0];
      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
      expect(header.kid).toBe('test-kid-1');
      expect(header.alg).toBe('RS256');
    });
  });

  describe('getJwks', () => {
    it('returns keys from IDENTITY_JWKS_KEYS env var', () => {
      const result = getJwks();
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0]).toHaveProperty('kid', 'test-kid-1');
      expect(result.keys[0]).toHaveProperty('kty', 'RSA');
    });
  });

  describe('issueRefreshToken', () => {
    it('creates a token and returns raw hex string', async () => {
      const raw = await issueRefreshToken(mockPool, 'user-1');
      expect(typeof raw).toBe('string');
      expect(raw).toHaveLength(64); // 32 bytes = 64 hex chars
      expect(vi.mocked(refreshTokenRepo.createToken)).toHaveBeenCalledOnce();

      const call = vi.mocked(refreshTokenRepo.createToken).mock.calls[0];
      expect(call[1].user_id).toBe('user-1');
      expect(call[1].token_hash).toBeTruthy();
      expect(call[1].token_hash).not.toBe(raw); // hash != raw
    });
  });

  describe('rotateRefreshToken', () => {
    it('throws 401 invalid_token when hash not found', async () => {
      vi.mocked(refreshTokenRepo.findByHash).mockResolvedValue(null);

      await expect(rotateRefreshToken(mockPool, 'unknown-token'))
        .rejects.toMatchObject({ message: 'invalid_token', statusCode: 401 });
    });

    it('throws 401 session_invalidated on replay (revoked token) and revokes all', async () => {
      vi.mocked(refreshTokenRepo.findByHash).mockResolvedValue({
        id: 'rt-1',
        user_id: 'user-1',
        token_hash: 'hash',
        expires_at: new Date(Date.now() + 86400000),
        revoked_at: new Date(),
        created_at: new Date(),
      });

      await expect(rotateRefreshToken(mockPool, 'reused-token'))
        .rejects.toMatchObject({ message: 'session_invalidated', statusCode: 401 });

      expect(vi.mocked(refreshTokenRepo.revokeAllForUser)).toHaveBeenCalledWith(mockPool, 'user-1');
    });

    it('throws 401 token_expired when token is expired', async () => {
      vi.mocked(refreshTokenRepo.findByHash).mockResolvedValue({
        id: 'rt-1',
        user_id: 'user-1',
        token_hash: 'hash',
        expires_at: new Date(Date.now() - 1000),
        revoked_at: null,
        created_at: new Date(),
      });

      await expect(rotateRefreshToken(mockPool, 'expired-token'))
        .rejects.toMatchObject({ message: 'token_expired', statusCode: 401 });
    });

    it('revokes old token and issues new one on success', async () => {
      vi.mocked(refreshTokenRepo.findByHash).mockResolvedValue({
        id: 'rt-1',
        user_id: 'user-1',
        token_hash: 'hash',
        expires_at: new Date(Date.now() + 86400000),
        revoked_at: null,
        created_at: new Date(),
      });

      const result = await rotateRefreshToken(mockPool, 'valid-token');

      expect(vi.mocked(refreshTokenRepo.revokeToken)).toHaveBeenCalledWith(mockPool, 'rt-1');
      expect(vi.mocked(refreshTokenRepo.createToken)).toHaveBeenCalled();
      expect(result.rawToken).toHaveLength(64);
      expect(result.userId).toBe('user-1');
    });
  });
});
