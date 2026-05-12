import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/referral-link.repo.js', () => ({
  findByCode: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../src/repositories/referrer.repo.js', () => ({
  findById: vi.fn(),
}));

import { generateCode, createLink } from '../../src/services/link.service.js';
import * as referralLinkRepo from '../../src/repositories/referral-link.repo.js';

const mockFindByCode = vi.mocked(referralLinkRepo.findByCode);
const mockCreate = vi.mocked(referralLinkRepo.create);

const fakeDb = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateCode', () => {
  it('returns exactly 8 characters', () => {
    const code = generateCode();
    expect(code).toHaveLength(8);
  });

  it('matches /^[A-Za-z0-9]{8}$/', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[A-Za-z0-9]{8}$/);
    }
  });
});

describe('createLink', () => {
  it('creates a link on first attempt when no collision', async () => {
    mockFindByCode.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      id: 'link-1',
      code: 'ABCD1234',
      redirect_url: 'https://example.com',
      referrer_id: 'ref-1',
      click_count: 0,
      status: 'active',
      created_by: null,
      created_at: new Date(),
    });

    const result = await createLink(fakeDb, 'ref-1', 'https://example.com');

    expect(result).toHaveProperty('id', 'link-1');
    expect(result).toHaveProperty('code', 'ABCD1234');
    expect(result).toHaveProperty('redirect_url', 'https://example.com');
    expect(mockFindByCode).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('retries on collision up to 5 times', async () => {
    // First 3 calls find existing codes, 4th succeeds
    mockFindByCode
      .mockResolvedValueOnce({ id: 'x' } as any) // collision 1
      .mockResolvedValueOnce({ id: 'x' } as any) // collision 2
      .mockResolvedValueOnce({ id: 'x' } as any) // collision 3
      .mockResolvedValueOnce(null); // no collision

    mockCreate.mockResolvedValue({
      id: 'link-2',
      code: 'WXYZ5678',
      redirect_url: 'https://example.com',
      referrer_id: 'ref-1',
      click_count: 0,
      status: 'active',
      created_by: null,
      created_at: new Date(),
    });

    const result = await createLink(fakeDb, 'ref-1', 'https://example.com');

    expect(result).toHaveProperty('id', 'link-2');
    expect(mockFindByCode).toHaveBeenCalledTimes(4);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws 500 error after 5 consecutive code collisions', async () => {
    mockFindByCode.mockResolvedValue({ id: 'x' } as any);

    try {
      await createLink(fakeDb, 'ref-1', 'https://example.com');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toMatch(/unique referral code/i);
      expect(err.statusCode).toBe(500);
    }

    expect(mockFindByCode).toHaveBeenCalledTimes(5);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
