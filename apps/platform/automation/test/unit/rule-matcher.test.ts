import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuleMatcher } from '../../src/services/rule-matcher.js';
import type { ActiveRule } from '../../src/repositories/rules.repository.js';
import type { RuleCache } from '../../src/services/rule-cache.js';
import type { InboundEvent } from '../../src/events/inbound-event.js';

vi.mock('../../src/services/condition-evaluator.js', () => ({
  evaluate: vi.fn(),
}));

import { evaluate } from '../../src/services/condition-evaluator.js';

const makeRule = (id: string, condition: unknown = null): ActiveRule => ({
  rule_id: id,
  rule_name: `Rule ${id}`,
  rule_version: 1,
  trigger_event_type: 'lead.created',
  condition,
  active_hours: null,
  action_tree: {},
});

const makeEvent = (): InboundEvent => ({
  event_id: 'evt-1',
  event_type: 'lead.created',
  entity_type: 'lead',
  entity_id: 'lead-42',
  payload: {},
});

const makeCache = (rules: ActiveRule[]): RuleCache =>
  ({
    getRulesForEvent: vi.fn().mockResolvedValue(rules),
  }) as unknown as RuleCache;

describe('RuleMatcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('single matching rule (truthy condition) — returned with correct execCtx', async () => {
    vi.mocked(evaluate).mockReturnValue(true);
    const rule = makeRule('r1', { op: 'eq', field: 'status', value: 'new' });
    const cache = makeCache([rule]);
    const matcher = new RuleMatcher(cache);

    const result = await matcher.matchRules(makeEvent());

    expect(result).toHaveLength(1);
    expect(result[0]!.rule).toBe(rule);
    expect(result[0]!.execCtx.event_id).toBe('evt-1');
    expect(result[0]!.execCtx.execution_id).toBeTruthy();
  });

  it('single non-matching rule (falsy condition) — empty result', async () => {
    vi.mocked(evaluate).mockReturnValue(false);
    const rule = makeRule('r1', { op: 'eq', field: 'status', value: 'new' });
    const cache = makeCache([rule]);
    const matcher = new RuleMatcher(cache);

    const result = await matcher.matchRules(makeEvent());

    expect(result).toHaveLength(0);
  });

  it('rule with null condition — always returned', async () => {
    vi.mocked(evaluate).mockReturnValue(true);
    const rule = makeRule('r1', null);
    const cache = makeCache([rule]);
    const matcher = new RuleMatcher(cache);

    const result = await matcher.matchRules(makeEvent());

    expect(result).toHaveLength(1);
    expect(evaluate).toHaveBeenCalledWith(null, expect.any(Object), expect.any(Object));
  });

  it('three rules with mixed conditions — only passing ones returned', async () => {
    vi.mocked(evaluate)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const r1 = makeRule('r1');
    const r2 = makeRule('r2');
    const r3 = makeRule('r3');
    const cache = makeCache([r1, r2, r3]);
    const matcher = new RuleMatcher(cache);

    const result = await matcher.matchRules(makeEvent());

    expect(result).toHaveLength(2);
    expect(result[0]!.rule).toBe(r1);
    expect(result[1]!.rule).toBe(r3);
  });

  it('empty cache result — returns []', async () => {
    const cache = makeCache([]);
    const matcher = new RuleMatcher(cache);

    const result = await matcher.matchRules(makeEvent());

    expect(result).toHaveLength(0);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('each matched rule gets its own unique execution_id', async () => {
    vi.mocked(evaluate).mockReturnValue(true);
    const rule = makeRule('r1');
    const cache = makeCache([rule]);
    const matcher = new RuleMatcher(cache);

    const [res1] = await matcher.matchRules(makeEvent());
    const [res2] = await matcher.matchRules(makeEvent());

    expect(res1!.execCtx.execution_id).not.toBe(res2!.execCtx.execution_id);
  });
});
