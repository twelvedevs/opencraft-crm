import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuleCache } from '../../src/services/rule-cache.js';
import type { ActiveRule, RulesRepository } from '../../src/repositories/rules.repository.js';

const makeRule = (id: string, eventType: string): ActiveRule => ({
  rule_id: id,
  rule_name: `Rule ${id}`,
  rule_version: 1,
  trigger_event_type: eventType,
  condition: null,
  active_hours: null,
  action_tree: {},
});

const makeRepo = (rules: ActiveRule[] = []): RulesRepository => ({
  findActiveByEventType: vi.fn().mockResolvedValue(rules),
} as unknown as RulesRepository);

describe('RuleCache', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('cache miss — repo called once and result returned', async () => {
    const rule = makeRule('r1', 'lead.created');
    const repo = makeRepo([rule]);
    const cache = new RuleCache(repo, 30_000);

    const result = await cache.getRulesForEvent('lead.created');

    expect(result).toEqual([rule]);
    expect(repo.findActiveByEventType).toHaveBeenCalledTimes(1);
  });

  it('second call within TTL — repo NOT called again, cached result returned', async () => {
    const rule = makeRule('r1', 'lead.created');
    const repo = makeRepo([rule]);
    const cache = new RuleCache(repo, 30_000);

    await cache.getRulesForEvent('lead.created');
    const result = await cache.getRulesForEvent('lead.created');

    expect(result).toEqual([rule]);
    expect(repo.findActiveByEventType).toHaveBeenCalledTimes(1);
  });

  it('call after TTL expires — repo called again', async () => {
    const rule = makeRule('r1', 'lead.created');
    const repo = makeRepo([rule]);
    const cache = new RuleCache(repo, 100);

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);

    await cache.getRulesForEvent('lead.created');

    // Advance time past TTL
    nowSpy.mockReturnValue(1200);

    await cache.getRulesForEvent('lead.created');

    expect(repo.findActiveByEventType).toHaveBeenCalledTimes(2);
  });

  it('invalidate() clears cache so next call goes to repo', async () => {
    const rule = makeRule('r1', 'lead.created');
    const repo = makeRepo([rule]);
    const cache = new RuleCache(repo, 30_000);

    await cache.getRulesForEvent('lead.created');
    cache.invalidate();
    await cache.getRulesForEvent('lead.created');

    expect(repo.findActiveByEventType).toHaveBeenCalledTimes(2);
  });

  it('two different eventTypes cached independently', async () => {
    const ruleA = makeRule('r1', 'lead.created');
    const ruleB = makeRule('r2', 'exam.scheduled');

    const repo = {
      findActiveByEventType: vi.fn()
        .mockResolvedValueOnce([ruleA])
        .mockResolvedValueOnce([ruleB]),
    } as unknown as RulesRepository;

    const cache = new RuleCache(repo, 30_000);

    const resA = await cache.getRulesForEvent('lead.created');
    const resB = await cache.getRulesForEvent('exam.scheduled');

    expect(resA).toEqual([ruleA]);
    expect(resB).toEqual([ruleB]);
    expect(repo.findActiveByEventType).toHaveBeenCalledTimes(2);
    expect(repo.findActiveByEventType).toHaveBeenCalledWith('lead.created');
    expect(repo.findActiveByEventType).toHaveBeenCalledWith('exam.scheduled');

    // Second calls should use cache (no more repo calls)
    await cache.getRulesForEvent('lead.created');
    await cache.getRulesForEvent('exam.scheduled');
    expect(repo.findActiveByEventType).toHaveBeenCalledTimes(2);
  });
});
