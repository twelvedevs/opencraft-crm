import { randomUUID } from 'node:crypto';
import type { ActiveRule } from '../repositories/rules.repository.js';
import type { RuleCache } from './rule-cache.js';
import { type Condition, evaluate } from './condition-evaluator.js';
import type { ExecutionContext } from './field-interpolator.js';
import type { InboundEvent } from '../events/inbound-event.js';

export interface MatchedRule {
  rule: ActiveRule;
  execCtx: ExecutionContext;
}

export class RuleMatcher {
  constructor(private readonly cache: RuleCache) {}

  async matchRules(event: InboundEvent): Promise<MatchedRule[]> {
    const rules = await this.cache.getRulesForEvent(event.event_type);
    const matched: MatchedRule[] = [];

    for (const rule of rules) {
      const execCtx: ExecutionContext = {
        event_id: event.event_id,
        execution_id: randomUUID(),
        rule_id: rule.rule_id,
        rule_version: rule.rule_version,
      };

      if (evaluate(rule.condition as Condition | null | undefined, event as Record<string, unknown>, execCtx)) {
        matched.push({ rule, execCtx });
      }
    }

    return matched;
  }
}
