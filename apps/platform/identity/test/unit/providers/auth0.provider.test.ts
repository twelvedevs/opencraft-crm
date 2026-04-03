import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock axios
vi.mock('axios', () => {
  const mockAxios = {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  };
  return { default: mockAxios };
});

// Mock node:crypto createPublicKey to return a fake key object that exports as PEM
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    createPublicKey: vi.fn(() => ({
      export: () => '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n',
    })),
  };
});

// Mock fast-jwt createVerifier to avoid real RSA verification in tests
vi.mock('fast-jwt', () => ({
  createVerifier: vi.fn(() => {
    // Return a sync verifier function that decodes the payload section
    return (token: string) => {
      const payloadB64 = token.split('.')[1];
      return JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    };
  }),
}));

import axios from 'axios';
import { createVerifier } from 'fast-jwt';
import { Auth0Provider } from '../../../src/providers/auth0.provider.js';

// Create a fake JWT with known payload for testing
function makeFakeJwt(payload: Record<string, unknown>, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-signature`;
}

describe('Auth0Provider', () => {
  let provider: Auth0Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Auth0Provider('test.auth0.com', 'client-id', 'client-secret');
  });

  function mockManagementToken() {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { access_token: 'mgmt-token', expires_in: 86400 },
    } as any);
  }

  describe('verifyToken', () => {
    it('fetches JWKS and verifies token', async () => {
      const testJwk = { kid: 'auth0-kid-1', kty: 'RSA', n: 'test-n', e: 'AQAB' };
      vi.mocked(axios.get).mockResolvedValue({ data: { keys: [testJwk] } } as any);

      const token = makeFakeJwt({ sub: 'auth0|user1', email: 'user@test.com' }, 'auth0-kid-1');
      const result = await provider.verifyToken(token);

      expect(result.providerUserId).toBe('auth0|user1');
      expect(result.email).toBe('user@test.com');
      expect(axios.get).toHaveBeenCalledWith('https://test.auth0.com/.well-known/jwks.json');
      // createVerifier is called with the PEM-exported key, not the raw JWK
      expect(createVerifier).toHaveBeenCalledWith({ algorithms: ['RS256'], key: expect.stringContaining('BEGIN PUBLIC KEY') });
    });

    it('throws when kid not found in JWKS', async () => {
      const testJwk = { kid: 'auth0-kid-1', kty: 'RSA', n: 'test-n', e: 'AQAB' };
      vi.mocked(axios.get).mockResolvedValue({ data: { keys: [testJwk] } } as any);

      const token = makeFakeJwt({ sub: 'auth0|user1', email: 'user@test.com' }, 'unknown-kid');

      await expect(provider.verifyToken(token)).rejects.toThrow('Unable to find matching key');
    });
  });

  describe('createUser', () => {
    it('calls Management API with correct params', async () => {
      mockManagementToken();
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { user_id: 'auth0|new-user' },
      } as any);

      const result = await provider.createUser('new@test.com', 'password123');
      expect(result).toEqual({ providerUserId: 'auth0|new-user' });

      const createCall = vi.mocked(axios.post).mock.calls[1];
      expect(createCall[0]).toBe('https://test.auth0.com/api/v2/users');
      expect(createCall[1]).toEqual({
        email: 'new@test.com',
        password: 'password123',
        connection: 'Username-Password-Authentication',
      });
    });
  });

  describe('setPassword', () => {
    it('calls PATCH /api/v2/users/{id} with password', async () => {
      mockManagementToken();
      vi.mocked(axios.patch).mockResolvedValue({} as any);

      await provider.setPassword('auth0|user1', 'new-pass');

      expect(axios.patch).toHaveBeenCalledWith(
        'https://test.auth0.com/api/v2/users/auth0%7Cuser1',
        { password: 'new-pass' },
        { headers: { Authorization: 'Bearer mgmt-token' } },
      );
    });
  });

  describe('deactivateUser', () => {
    it('calls PATCH with blocked: true', async () => {
      mockManagementToken();
      vi.mocked(axios.patch).mockResolvedValue({} as any);

      await provider.deactivateUser('auth0|user1');

      expect(axios.patch).toHaveBeenCalledWith(
        'https://test.auth0.com/api/v2/users/auth0%7Cuser1',
        { blocked: true },
        { headers: { Authorization: 'Bearer mgmt-token' } },
      );
    });
  });

  describe('signInWithPassword', () => {
    it('calls POST /oauth/token with password grant', async () => {
      vi.mocked(axios.post).mockResolvedValue({} as any);

      await provider.signInWithPassword('user@test.com', 'password');

      expect(axios.post).toHaveBeenCalledWith('https://test.auth0.com/oauth/token', {
        grant_type: 'password',
        client_id: 'client-id',
        client_secret: 'client-secret',
        username: 'user@test.com',
        password: 'password',
        audience: 'https://test.auth0.com/api/v2/',
      });
    });
  });

  describe('JWKS caching', () => {
    it('caches JWKS and does not re-fetch on subsequent verifyToken calls with the same kid', async () => {
      const testJwk = { kid: 'auth0-kid-1', kty: 'RSA', n: 'test-n', e: 'AQAB' };
      vi.mocked(axios.get).mockResolvedValue({ data: { keys: [testJwk] } } as any);

      const token = makeFakeJwt({ sub: 'auth0|user1', email: 'user@test.com' }, 'auth0-kid-1');

      await provider.verifyToken(token);
      await provider.verifyToken(token);

      // JWKS endpoint should only be fetched once; second call uses the cache
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('re-fetches JWKS when the token kid is not in the cache', async () => {
      const jwk1 = { kid: 'auth0-kid-1', kty: 'RSA', n: 'n1', e: 'AQAB' };
      const jwk2 = { kid: 'auth0-kid-2', kty: 'RSA', n: 'n2', e: 'AQAB' };
      vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { keys: [jwk1] } } as any)  // first call
        .mockResolvedValueOnce({ data: { keys: [jwk1, jwk2] } } as any); // re-fetch

      const token1 = makeFakeJwt({ sub: 'auth0|user1', email: 'user@test.com' }, 'auth0-kid-1');
      const token2 = makeFakeJwt({ sub: 'auth0|user2', email: 'user2@test.com' }, 'auth0-kid-2');

      await provider.verifyToken(token1);
      await provider.verifyToken(token2); // kid-2 not in cache → re-fetch

      expect(axios.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('M2M token caching', () => {
    it('reuses cached token across calls', async () => {
      mockManagementToken();
      vi.mocked(axios.patch).mockResolvedValue({} as any);
      await provider.setPassword('auth0|user1', 'pass1');

      vi.mocked(axios.patch).mockResolvedValue({} as any);
      await provider.deactivateUser('auth0|user1');

      const tokenCalls = vi.mocked(axios.post).mock.calls.filter(
        (call) => call[0] === 'https://test.auth0.com/oauth/token',
      );
      expect(tokenCalls).toHaveLength(1);
    });

    it('refreshes token when near expiry', async () => {
      // First call with token expiring within 60s buffer
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { access_token: 'short-lived-token', expires_in: 30 },
      } as any);
      vi.mocked(axios.patch).mockResolvedValue({} as any);
      await provider.setPassword('auth0|user1', 'pass1');

      // Second call should fetch new token
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { access_token: 'new-token', expires_in: 86400 },
      } as any);
      vi.mocked(axios.patch).mockResolvedValue({} as any);
      await provider.deactivateUser('auth0|user1');

      const tokenCalls = vi.mocked(axios.post).mock.calls.filter(
        (call) => call[0] === 'https://test.auth0.com/oauth/token',
      );
      expect(tokenCalls).toHaveLength(2);
    });
  });
});
