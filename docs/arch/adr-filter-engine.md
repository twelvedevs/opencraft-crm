# ADR: @platform/filter-engine — Filter Evaluation Package

**Date:** 2026-04-02
**Status:** Accepted
**Package:** `packages/@platform/filter-engine`

---

## Context

The Audience Engine and the Automation Engine both evaluate JSON condition trees against entity data at runtime. Without a shared package, each service would maintain its own evaluator — two implementations of the same logic with independent bug histories and diverging operator sets.

`@platform/filter-engine` provides a single pure-function evaluator that both services import. It has zero runtime dependencies and no I/O — it is a computation kernel only.

**Current consumers:**
- `apps/platform/audience` — Audience Engine. Uses base + temporal operators. Passes `EvalContext` with the current timestamp for segment evaluation.
- `apps/platform/automation` — Automation Engine. Uses base operators only. Currently has its own `condition-evaluator.ts`; migration to `@platform/filter-engine` is a planned follow-up task. Until migration, both implementations coexist.

---

## Decision

Provide a `evaluate()` pure function that recursively walks a `FilterNode` tree and returns a boolean. Operators are split into two files:

- `operators/base.ts` — the 11 base operators shared with the Automation Engine. No `EvalContext` required.
- `operators/temporal.ts` — 5 timestamp operators used by the Audience Engine. Require `EvalContext` to receive an injected `now` rather than calling `Date.now()` internally (makes tests deterministic and DST-safe).

A missing field evaluates as `undefined`. `not_exists` passes; all other operators return `false`. Unknown operators throw with a descriptive error.

---

## Core Types

### `FilterNode`

The discriminated union accepted by `evaluate()`. A filter is always one of three node shapes:

```ts
type FilterNode = ConditionNode | GroupNode | NotNode;
```

### `ConditionNode`

A leaf node. Tests one field of the entity against one value.

```ts
interface ConditionNode {
  field: string;   // dot-notation path, e.g. "address.city" or "items.0.name"
  op:
    | 'eq' | 'neq'
    | 'in' | 'not_in'
    | 'gt' | 'gte' | 'lt' | 'lte'
    | 'contains'
    | 'exists' | 'not_exists'
    | 'within_last' | 'not_within_last'
    | 'before' | 'after' | 'date_range';
  value?: unknown; // absent for exists / not_exists
}
```

### `GroupNode`

An AND or OR combinator over an array of child nodes. Nestable.

```ts
interface GroupNode {
  op: 'AND' | 'OR';
  conditions: FilterNode[];  // array, not singular
}
```

### `NotNode`

Boolean negation of a single child. Note: `condition` (singular), not `conditions` (array).

```ts
interface NotNode {
  op: 'NOT';
  condition: FilterNode;  // singular child
}
```

### `EvalContext`

Required when any temporal operator is used. Provides the reference timestamp so callers control time rather than the evaluator calling `Date.now()` internally.

```ts
interface EvalContext {
  now: Date;
}
```

### Type guards

Three type guards are exported for consumers that need to distinguish node shapes:

```ts
isGroup(node: FilterNode): node is GroupNode
isNot(node: FilterNode): node is NotNode
isLeaf(node: FilterNode): node is ConditionNode
```

---

## API

### `evaluate(filter, entity, context?)`

```ts
evaluate(
  filter: FilterNode,
  entity: Record<string, unknown>,
  context?: EvalContext,
): boolean
```

Recursively evaluates `filter` against `entity`. Returns `true` if the entity satisfies the filter, `false` otherwise.

**Dispatch logic:**

| Node shape | Behaviour |
|---|---|
| `GroupNode` (`AND`) | Returns `true` if **all** children evaluate to `true` (short-circuits on first `false`) |
| `GroupNode` (`OR`) | Returns `true` if **any** child evaluates to `true` (short-circuits on first `true`) |
| `NotNode` | Returns the boolean inverse of evaluating the single `condition` child |
| `ConditionNode` (base op) | Resolves `field` on `entity`, applies the operator, returns boolean |
| `ConditionNode` (temporal op) | Same, but requires `context`. Throws if `context` is absent. |

**Field resolution:**

Fields are resolved by dot-notation path against the entity object. `"address.city"` resolves to `entity.address.city`. Array index access is supported: `"items.0.name"` resolves to `entity.items[0].name`. A missing or `null` intermediate node resolves to `undefined`.

**Missing field semantics:**
- `not_exists` — returns `true`
- `exists` — returns `false`
- All other operators — return `false`

**Throws:**
- `Error('Unknown base operator: <op>')` — operator is not in the known set
- `Error('EvalContext with { now: Date } is required for temporal operators')` — temporal operator called without `context`

---

## Filter DSL Reference

### Base Operators

| Operator | Description | `value` type |
|---|---|---|
| `eq` | Field equals value | any scalar |
| `neq` | Field does not equal value | any scalar |
| `in` | Field value is in the array | `unknown[]` |
| `not_in` | Field value is not in the array | `unknown[]` |
| `gt` | Field > value (numeric) | number |
| `gte` | Field >= value (numeric) | number |
| `lt` | Field < value (numeric) | number |
| `lte` | Field <= value (numeric) | number |
| `contains` | String field contains substring, or array field contains element | string or any |
| `exists` | Field is present and not null | — (no `value`) |
| `not_exists` | Field is absent or null | — (no `value`) |

### Temporal Operators

Temporal operators require `EvalContext`. Time arithmetic uses milliseconds from `context.now.getTime()` — DST transitions do not shift boundaries.

| Operator | Description | `value` type |
|---|---|---|
| `within_last` | Field timestamp >= `now - N` (inclusive boundary) | `{ amount: number; unit: 'days' \| 'hours' }` |
| `not_within_last` | Field timestamp < `now - N` (strictly older) | `{ amount: number; unit: 'days' \| 'hours' }` |
| `before` | Field timestamp < fixed date (strict) | ISO 8601 string |
| `after` | Field timestamp > fixed date (strict) | ISO 8601 string |
| `date_range` | Field timestamp >= start AND <= end (both inclusive) | `{ start: string; end: string }` |

**`within_last` boundary:** The boundary moment itself counts as "within last N". Semantically: `field >= now - N`. `not_within_last` is the strict complement: `field < now - N`.

---

## Examples

### 1. Simple equality and array membership

```ts
import { evaluate } from '@platform/filter-engine';

const filter = {
  op: 'AND',
  conditions: [
    { field: 'pipeline',    op: 'eq',  value: 'new_patient' },
    { field: 'stage',       op: 'in',  value: ['contacted', 'exam_scheduled'] },
    { field: 'opted_out',   op: 'eq',  value: false },
  ],
};

evaluate(filter, {
  pipeline: 'new_patient',
  stage: 'contacted',
  opted_out: false,
});
// → true

evaluate(filter, {
  pipeline: 'new_patient',
  stage: 'contacted',
  opted_out: true,   // opted out — fails last condition
});
// → false
```

---

### 2. Nested AND / OR / NOT

```ts
const filter = {
  op: 'AND',
  conditions: [
    {
      op: 'OR',
      conditions: [
        { field: 'location_id', op: 'eq', value: 'loc-1' },
        { field: 'location_id', op: 'eq', value: 'loc-2' },
      ],
    },
    {
      op: 'NOT',
      condition: { field: 'custom_tags', op: 'contains', value: 'excluded' },
    },
  ],
};

evaluate(filter, { location_id: 'loc-1', custom_tags: ['vip'] });
// → true  (loc-1 matches, tag 'excluded' absent)

evaluate(filter, { location_id: 'loc-1', custom_tags: ['excluded'] });
// → false  (location matches but tag exclusion fires)

evaluate(filter, { location_id: 'loc-3', custom_tags: [] });
// → false  (location doesn't match OR)
```

---

### 3. Temporal operators — "no contact in 5 days"

The caller enriches each entity with `last_contact_at` before passing it to `evaluate`. The Audience Engine passes the snapshot start time as `now` so all entities in a batch are evaluated against the same reference point.

```ts
import { evaluate } from '@platform/filter-engine';
import type { EvalContext } from '@platform/filter-engine';

const filter = {
  op: 'AND',
  conditions: [
    { field: 'stage',           op: 'eq',             value: 'contacted' },
    { field: 'last_contact_at', op: 'not_within_last', value: { amount: 5, unit: 'days' } },
    { field: 'opted_out',       op: 'eq',             value: false },
  ],
};

const context: EvalContext = { now: new Date() };

evaluate(filter, {
  stage: 'contacted',
  last_contact_at: '2026-03-10T09:00:00Z',  // 5+ days ago
  opted_out: false,
}, context);
// → true  (no contact in 5 days, still in 'contacted', not opted out)

evaluate(filter, {
  stage: 'contacted',
  last_contact_at: new Date().toISOString(),  // contacted today
  opted_out: false,
}, context);
// → false  (within_last 5 days)
```

---

### 4. Dot-notation field resolution — nested object and array index

```ts
const cityFilter = { field: 'address.city', op: 'eq', value: 'Boston' };

evaluate(cityFilter, { address: { city: 'Boston' } });
// → true

evaluate(cityFilter, { address: null });
// → false  (null intermediate → undefined → false for eq)

// Array index access
const firstTagFilter = { field: 'tags.0', op: 'eq', value: 'vip' };

evaluate(firstTagFilter, { tags: ['vip', 'referral'] });
// → true

evaluate(firstTagFilter, { tags: [] });
// → false  (index 0 is undefined → false for eq)
```

---

### 5. Automation Engine usage — base operators only, no EvalContext

The Automation Engine evaluates trigger conditions against event payloads. It uses only base operators; `context` is omitted.

```ts
import { evaluate } from '@platform/filter-engine';

// Trigger: fire if the lead moved into the 'exam_scheduled' stage at a watched location
const triggerFilter = {
  op: 'AND',
  conditions: [
    { field: 'stage',       op: 'eq', value: 'exam_scheduled' },
    { field: 'location_id', op: 'in', value: ['loc-1', 'loc-3', 'loc-7'] },
  ],
};

// Payload provided by the Automation Engine from the incoming event
const entity = {
  stage: 'exam_scheduled',
  location_id: 'loc-3',
  pipeline: 'new_patient',
};

evaluate(triggerFilter, entity);  // no context — base ops only
// → true
```

---

## Constraints and Gotchas

- **Missing field is always `false`** (except `not_exists`). If the caller forgets to enrich the entity with a field that the filter references, the condition silently fails rather than throwing. Check entity shape at the call site if unexpected `false` results appear.
- **`NOT` takes `condition` (singular), not `conditions` (array).** Passing `conditions` to a `NOT` node will either fail TypeScript compilation or evaluate incorrectly at runtime if types are bypassed.
- **Temporal operators throw without `EvalContext`.** Do not mix temporal and base operators in a filter that may be evaluated without a context. If a filter is shared between the Automation Engine (no context) and the Audience Engine (with context), ensure it uses base operators only.
- **No aggregate operators.** "No contact in X days" requires the caller to enrich each entity with a `last_contact_at` field before submission. The evaluator has no concept of querying across entities or computing aggregate values.
- **`contains` on a non-string, non-array field returns `false`.** It does not throw.
- **Numeric operators coerce via `Number()`.** `gt`, `gte`, `lt`, `lte` call `Number(fieldValue)` and `Number(node.value)`. A non-numeric string field produces `NaN`; `NaN > X` is always `false`.

---

## Consequences

**Good:**
- Single source of truth for filter evaluation logic shared across Audience Engine and (post-migration) Automation Engine.
- Zero runtime dependencies — safe to bundle into browser-side tooling or lightweight Lambda functions.
- DST-safe: temporal arithmetic operates on milliseconds from `getTime()`, never on local wall-clock operations. Boundary behavior is deterministic regardless of the server's timezone.
- `EvalContext` injection makes temporal tests fully deterministic — no `Date.now()` stubbing required.

**Watch out for:**
- Until the Automation Engine migration completes, two evaluator implementations coexist. If a base operator behavior needs to change (e.g. `contains` case-sensitivity), both `@platform/filter-engine` and `apps/platform/automation/src/condition-evaluator.ts` must be updated together.
- The evaluator is stateless and has no schema awareness. It cannot validate that a filter references fields that actually exist on an entity type — that validation belongs to the caller (e.g. the Audience Engine validates filter structure on segment creation, but not field names).
