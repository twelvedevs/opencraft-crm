import { describe, it, expect, vi } from 'vitest';
import { NumberResolver, NumberNotFoundError } from '../../src/services/number-resolver.js';
import type { NumbersRepository } from '../../src/repositories/numbers.repo.js';

function createMockRepo(): NumbersRepository {
  return {
    findById: vi.fn(),
    findByLocationAndChannel: vi.fn(),
    findByPhoneNumber: vi.fn(),
    findAll: vi.fn(),
    create: vi.fn(),
    deactivate: vi.fn(),
    delete: vi.fn(),
  } as unknown as NumbersRepository;
}

describe('NumberResolver', () => {
  it('returns explicit from_number with default rate_limit_mps when not in pool', async () => {
    const repo = createMockRepo();
    vi.mocked(repo.findByPhoneNumber).mockResolvedValue(null);

    const resolver = new NumberResolver(repo);
    const result = await resolver.resolve({ from_number: '+15550001111' });

    expect(result).toEqual({ phone_number: '+15550001111', rate_limit_mps: 3 });
    expect(repo.findByPhoneNumber).toHaveBeenCalledWith('+15550001111');
  });

  it('returns phone_number and rate_limit_mps from DB for location_id+channel lookup', async () => {
    const repo = createMockRepo();
    vi.mocked(repo.findByLocationAndChannel).mockResolvedValue({
      id: 'uuid-1',
      location_id: 'loc-1',
      channel: 'sms_inbox',
      phone_number: '+15550001001',
      friendly_name: null,
      active: true,
      rate_limit_mps: 5,
      created_at: '2026-01-01T00:00:00Z',
    });

    const resolver = new NumberResolver(repo);
    const result = await resolver.resolve({ location_id: 'loc-1', channel: 'sms_inbox' });

    expect(result).toEqual({ phone_number: '+15550001001', rate_limit_mps: 5 });
  });

  it('throws NumberNotFoundError when location_id+channel lookup misses', async () => {
    const repo = createMockRepo();
    vi.mocked(repo.findByLocationAndChannel).mockResolvedValue(null);

    const resolver = new NumberResolver(repo);
    await expect(resolver.resolve({ location_id: 'loc-x', channel: 'sms_inbox' }))
      .rejects.toThrow(NumberNotFoundError);
  });

  it('does not return inactive numbers via location_id+channel', async () => {
    const repo = createMockRepo();
    // findByLocationAndChannel already filters active=true, so null means no active match
    vi.mocked(repo.findByLocationAndChannel).mockResolvedValue(null);

    const resolver = new NumberResolver(repo);
    await expect(resolver.resolve({ location_id: 'loc-1', channel: 'google' }))
      .rejects.toThrow(NumberNotFoundError);
  });
});
