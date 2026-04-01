import { evaluate, type FilterNode } from '@platform/filter-engine';

export class FilterEvaluator {
  evaluate(filter: unknown, entity: Record<string, unknown>): boolean {
    return evaluate(filter as FilterNode, entity, { now: new Date() });
  }
}
