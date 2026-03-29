import type { DomainRepository, SendingDomain } from '../repositories/domain-repository.js';
import { DomainNotConfiguredError, DomainNotVerifiedError } from '../errors.js';

interface CacheEntry {
  domain: SendingDomain;
  expiresAt: number;
}

export class DomainResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly repo: DomainRepository) {}

  async resolve(locationId: string): Promise<SendingDomain> {
    const cached = this.cache.get(locationId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.domain;
    }

    const domain = await this.repo.findByLocationId(locationId);
    if (!domain) {
      throw new DomainNotConfiguredError(locationId);
    }
    if (!domain.is_verified) {
      throw new DomainNotVerifiedError(locationId);
    }

    this.cache.set(locationId, { domain, expiresAt: Date.now() + 60_000 });
    return domain;
  }

  invalidate(locationId: string): void {
    this.cache.delete(locationId);
  }
}
