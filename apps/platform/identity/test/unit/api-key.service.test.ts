import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/api-key.repo.js', () => ({
  createKey: vi.fn(),
  findByHash: vi.fn(),
  listKeys: vi.fn(),
  revokeKey: vi.fn().mockResolvedValue(undefined),
  touchLastUsed: vi.fn().mockResolvedValue(undefined),
}));

import { generateApiKey, listApiKeys, validateApiKey, revokeApiKey } from '../../src/services/api-key.service.js';
import * as apiKeyRepo from '../../src/repositories/api-key.repo.js';

const mockPool = {
  query: vi.fn(),
} as any;

describe('api-key.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateApiKey', () => {
    it('returns key with ak_ prefix and stores hash', async () => {
      vi.mocked(apiKeyRepo.createKey).mockResolvedValue({
        id: 'key-1',
        name: 'Test Key',
        key_hash: 'some-hash',
        permissions: ['leads:read'],
        created_by: null,
        created_at: new Date(),
        last_used_at: null,
        revoked_at: null,
      });

      const result = await generateApiKey(mockPool, {
        name: 'Test Key',
        permissions: ['leads:read'],
      });

      expect(result.key).toMatch(/^ak_[a-f0-9]{64}$/);
      expect(result.id).toBe('key-1');
      expect(result.name).toBe('Test Key');
      expect(result.permissions).toEqual(['leads:read']);

      // Verify hash was stored, not raw key
      const call = vi.mocked(apiKeyRepo.createKey).mock.calls[0];
      expect(call[1].key_hash).not.toBe(result.key);
      expect(call[1].key_hash).toHaveLength(64); // SHA256 hex
    });
  });

  describe('listApiKeys', () => {
    it('returns non-revoked keys without key_hash', async () => {
      vi.mocked(apiKeyRepo.listKeys).mockResolvedValue([
        {
          id: 'key-1',
          name: 'Active Key',
          key_hash: 'secret-hash',
          permissions: ['leads:read'],
          created_by: null,
          created_at: new Date(),
          last_used_at: null,
          revoked_at: null,
        },
        {
          id: 'key-2',
          name: 'Revoked Key',
          key_hash: 'secret-hash-2',
          permissions: ['leads:write'],
          created_by: null,
          created_at: new Date(),
          last_used_at: null,
          revoked_at: new Date(),
        },
      ]);

      const result = await listApiKeys(mockPool);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('key-1');
      expect(result[0]).not.toHaveProperty('key_hash');
    });
  });

  describe('validateApiKey', () => {
    it('throws 401 for unknown key', async () => {
      vi.mocked(apiKeyRepo.findByHash).mockResolvedValue(null);

      await expect(validateApiKey(mockPool, 'ak_unknown'))
        .rejects.toMatchObject({ statusCode: 401, message: 'invalid_key' });
    });

    it('throws 401 for revoked key', async () => {
      vi.mocked(apiKeyRepo.findByHash).mockResolvedValue({
        id: 'key-1',
        name: 'Revoked',
        key_hash: 'hash',
        permissions: ['leads:read'],
        created_by: null,
        created_at: new Date(),
        last_used_at: null,
        revoked_at: new Date(),
      });

      await expect(validateApiKey(mockPool, 'ak_revoked'))
        .rejects.toMatchObject({ statusCode: 401, message: 'invalid_key' });
    });

    it('returns permissions and calls touchLastUsed on success', async () => {
      vi.mocked(apiKeyRepo.findByHash).mockResolvedValue({
        id: 'key-1',
        name: 'Valid',
        key_hash: 'hash',
        permissions: ['leads:read', 'leads:write'],
        created_by: null,
        created_at: new Date(),
        last_used_at: null,
        revoked_at: null,
      });

      const result = await validateApiKey(mockPool, 'ak_valid');
      expect(result.permissions).toEqual(['leads:read', 'leads:write']);
      expect(apiKeyRepo.touchLastUsed).toHaveBeenCalledWith(mockPool, 'key-1');
    });
  });

  describe('revokeApiKey', () => {
    it('revokes an existing key', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ id: 'key-1' }] });

      await revokeApiKey(mockPool, 'key-1');
      expect(apiKeyRepo.revokeKey).toHaveBeenCalledWith(mockPool, 'key-1');
    });

    it('throws 404 for non-existent key', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(revokeApiKey(mockPool, 'missing'))
        .rejects.toMatchObject({ statusCode: 404, message: 'not_found' });
    });
  });
});
