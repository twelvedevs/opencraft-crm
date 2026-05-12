import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DomainResolver } from './domain-resolver.js';
import { DomainNotConfiguredError, DomainNotVerifiedError } from '../errors.js';
import type { SendingDomain } from '../repositories/domain-repository.js';

const makeDomain = (overrides: Partial<SendingDomain> = {}): SendingDomain => ({
  id: '00000000-0000-0000-0000-000000000001',
  location_id: 'loc-1',
  domain: 'mail.example.com',
  from_name: 'Test',
  from_email: 'test@example.com',
  is_verified: true,
  spam_score_threshold: 5.0,
  sendgrid_domain_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

const makeMockRepo = () => ({
  findByLocationId: vi.fn(),
  findById: vi.fn(),
  findAll: vi.fn(),
  create: vi.fn(),
  updateVerified: vi.fn(),
  delete: vi.fn(),
  hasSentEmailsIn30Days: vi.fn(),
});

describe('DomainResolver', () => {
  let repo: ReturnType<typeof makeMockRepo>;
  let resolver: DomainResolver;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repo = makeMockRepo();
    resolver = new DomainResolver(repo as unknown as import('../repositories/domain-repository.js').DomainRepository);
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cache miss calls repo and stores result', async () => {
    const domain = makeDomain();
    repo.findByLocationId.mockResolvedValue(domain);

    const result = await resolver.resolve('loc-1');

    expect(repo.findByLocationId).toHaveBeenCalledWith('loc-1');
    expect(result).toEqual(domain);
  });

  it('cache hit returns domain without calling repo again', async () => {
    const domain = makeDomain();
    repo.findByLocationId.mockResolvedValue(domain);

    await resolver.resolve('loc-1');
    await resolver.resolve('loc-1');

    expect(repo.findByLocationId).toHaveBeenCalledTimes(1);
  });

  it('TTL expiry causes re-fetch from repo', async () => {
    const domain = makeDomain();
    repo.findByLocationId.mockResolvedValue(domain);

    await resolver.resolve('loc-1');

    // Advance time past TTL (60_000 ms)
    nowSpy.mockReturnValue(62_000);

    await resolver.resolve('loc-1');

    expect(repo.findByLocationId).toHaveBeenCalledTimes(2);
  });

  it('throws DomainNotConfiguredError when repo returns null', async () => {
    repo.findByLocationId.mockResolvedValue(null);

    await expect(resolver.resolve('loc-missing')).rejects.toThrow(DomainNotConfiguredError);
    await expect(resolver.resolve('loc-missing')).rejects.toThrow(
      'Domain not configured for location: loc-missing',
    );
  });

  it('throws DomainNotVerifiedError when domain is not verified', async () => {
    repo.findByLocationId.mockResolvedValue(makeDomain({ is_verified: false }));

    await expect(resolver.resolve('loc-1')).rejects.toThrow(DomainNotVerifiedError);
    await expect(resolver.resolve('loc-1')).rejects.toThrow(
      'Domain not verified for location: loc-1',
    );
  });

  it('invalidate removes cache entry so next call hits repo', async () => {
    const domain = makeDomain();
    repo.findByLocationId.mockResolvedValue(domain);

    await resolver.resolve('loc-1');
    resolver.invalidate('loc-1');
    await resolver.resolve('loc-1');

    expect(repo.findByLocationId).toHaveBeenCalledTimes(2);
  });
});
