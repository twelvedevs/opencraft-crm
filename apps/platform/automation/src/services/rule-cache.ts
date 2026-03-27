import type { ActiveRule, RulesRepository } from '../repositories/rules.repository.js';

interface CacheEntry {
  rules: ActiveRule[];
  cachedAt: number;
}

export class RuleCache {
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly repo: RulesRepository,
    ttlMs?: number,
  ) {
    this.ttlMs = ttlMs ?? parseInt(process.env['RULE_CACHE_TTL_MS'] ?? '30000', 10);
  }

  async getRulesForEvent(eventType: string): Promise<ActiveRule[]> {
    const entry = this.cache.get(eventType);
    if (entry !== undefined && Date.now() - entry.cachedAt < this.ttlMs) {
      return entry.rules;
    }
    const rules = await this.repo.findActiveByEventType(eventType);
    this.cache.set(eventType, { rules, cachedAt: Date.now() });
    return rules;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
