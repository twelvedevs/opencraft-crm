# ADR: @ortho/interpolator — Field Interpolation & Active Hours Package

**Date:** 2026-03-31
**Status:** Accepted
**Package:** `packages/@ortho/interpolator`

---

## Context

The Automation Engine and Nurturing Engine both need to resolve dynamic values from event payloads and execution context before calling downstream platform services (Messaging, Email, AI, etc.). Two distinct interpolation patterns emerged:

1. **Dot-notation paths** (`"payload.phone"`) — resolve a value from a nested data object (e.g. an EventBridge event payload or enrollment context).
2. **Template tokens** (`"{{event_id}}-sms-1"`) — substitute computed identifiers (event IDs, execution IDs, rule versions) into strings, typically for dedup keys.

Both engines also need to compute **active-hours delays** — determining how many milliseconds to defer a messaging action until the next business-hours window opens in the recipient's timezone.

Rather than duplicating this logic in each service, the `@ortho/interpolator` package provides a single, zero-dependency, pure-function implementation shared by both engines.

---

## Decision

Provide `@ortho/interpolator` with two interpolation APIs (single-context and dual-context) and two active-hours functions. All exports are pure functions with no I/O, no external dependencies, and no side effects.

---

## Core Concepts

### Dot-Notation Paths

A string value like `"payload.location_timezone"` is recognized as a path and resolved against a context object using deep property traversal. The path must contain at least one dot (`.`) in single-context mode to distinguish it from literal strings.

### Template Tokens

A string containing `{{key}}` patterns gets token replacement. Tokens that don't exist in the context are preserved as-is (not stripped), so downstream consumers can detect unresolved tokens.

### Single-Context vs Dual-Context

| Mode | API | Used by | Behavior |
|------|-----|---------|----------|
| **Single-context** | `interpolateValue`, `interpolateFields` | Nurturing Engine | One merged context for both dot-paths and template tokens. Single-word strings (e.g. `"haiku"`) are treated as **literals** — a dot is required for path resolution. |
| **Dual-context** | `resolveValue`, `resolveParams` | Automation Engine | Separate `dataCtx` (dot-paths) and `templateCtx` (template tokens). Single-segment strings **are** resolved against `dataCtx` since template tokens live in a separate namespace. |

The distinction exists because the Automation Engine separates event payload data from execution metadata (event_id, execution_id, rule_id), while the Nurturing Engine merges enrollment context and step metadata into a single object.

---

## API

### `getByPath(obj: Record<string, unknown>, path: string): unknown`

Traverses a nested object by splitting `path` on dots. Returns `undefined` if any intermediate segment is null, undefined, or not an object.

```ts
import { getByPath } from '@ortho/interpolator';

const event = {
  payload: {
    lead: { phone: '+15551234567' },
    location_timezone: 'America/New_York',
  },
};

getByPath(event, 'payload.lead.phone');
// => '+15551234567'

getByPath(event, 'payload.missing.field');
// => undefined
```

---

### `interpolateValue(value: unknown, context: Record<string, unknown>): unknown`

**Single-context resolver.** Resolves one value against a single context object.

- If `value` is not a string, returns it unchanged.
- If the string matches dot-notation (contains at least one `.`), resolves via `getByPath`.
- If the string contains `{{token}}` patterns, replaces them from `context`.
- Otherwise returns the string as a literal.

```ts
import { interpolateValue } from '@ortho/interpolator';

const ctx = {
  context: { phone: '+15551234567', timezone: 'America/New_York' },
  enrollment_id: 'enr-abc-123',
};

// Dot-notation path — requires a dot
interpolateValue('context.phone', ctx);
// => '+15551234567'

// Template token
interpolateValue('{{enrollment_id}}-step-1', ctx);
// => 'enr-abc-123-step-1'

// Single-word string — treated as literal (no dot)
interpolateValue('haiku', ctx);
// => 'haiku'

// Non-string values pass through
interpolateValue(42, ctx);
// => 42
```

---

### `interpolateFields(params: Record<string, unknown>, context: Record<string, unknown>): Record<string, unknown>`

**Single-context recursive resolver.** Walks an entire params object — recursing into nested objects and arrays — and applies `interpolateValue` to every string leaf.

```ts
import { interpolateFields } from '@ortho/interpolator';

const ctx = {
  context: {
    phone: '+15551234567',
    email: 'jane@example.com',
    location_timezone: 'America/New_York',
  },
  enrollment_id: 'enr-abc-123',
};

const params = {
  to_field: 'context.phone',
  template_id: 'welcome-sms',
  dedup_key: '{{enrollment_id}}-sms-1',
  nested: {
    email: 'context.email',
    tags: ['context.location_timezone', 'literal-value'],
  },
};

interpolateFields(params, ctx);
// => {
//   to_field: '+15551234567',
//   template_id: 'welcome-sms',        // no dot, no token — literal
//   dedup_key: 'enr-abc-123-sms-1',
//   nested: {
//     email: 'jane@example.com',
//     tags: ['America/New_York', 'literal-value'],
//   },
// }
```

---

### `resolveValue(value: unknown, dataCtx: Record<string, unknown>, templateCtx: Record<string, unknown>): unknown`

**Dual-context resolver.** Dot-notation paths are resolved from `dataCtx`; template tokens from `templateCtx`. Unlike `interpolateValue`, single-segment strings (no dot) **are** resolved against `dataCtx`.

```ts
import { resolveValue } from '@ortho/interpolator';

const dataCtx = {
  payload: {
    phone: '+15551234567',
    entity_type: 'lead',
  },
};

const templateCtx = {
  event_id: 'evt-xyz-789',
  rule_id: 'rule-001',
};

// Dot-notation path from dataCtx
resolveValue('payload.phone', dataCtx, templateCtx);
// => '+15551234567'

// Template tokens from templateCtx
resolveValue('{{event_id}}-sms', dataCtx, templateCtx);
// => 'evt-xyz-789-sms'

// Multiple tokens
resolveValue('{{event_id}}-{{rule_id}}', dataCtx, templateCtx);
// => 'evt-xyz-789-rule-001'

// Unknown tokens preserved
resolveValue('{{unknown_key}}', dataCtx, templateCtx);
// => '{{unknown_key}}'

// Template tokens don't cross into dataCtx
resolveValue('{{payload}}', dataCtx, templateCtx);
// => '{{payload}}'  (not the payload object)
```

---

### `resolveParams(params: Record<string, unknown>, dataCtx: Record<string, unknown>, templateCtx: Record<string, unknown>): Record<string, unknown>`

**Dual-context recursive resolver.** Walks the entire params object — recursing into nested objects and arrays — applying `resolveValue` to every string leaf.

```ts
import { resolveParams } from '@ortho/interpolator';

const dataCtx = {
  payload: {
    entity_type: 'lead',
    entity_id: 'lead-456',
    location_id: 'loc-34',
  },
};

const templateCtx = {
  event_id: 'evt-xyz-789',
};

const actionParams = {
  event_type: 'automation.action_requested',
  payload: {
    action: 'assign_coordinator',
    entity_type: 'payload.entity_type',
    entity_id: 'payload.entity_id',
    params: { location_id: 'payload.location_id' },
    dedup_key: '{{event_id}}-emit-assign',
  },
};

resolveParams(actionParams, dataCtx, templateCtx);
// => {
//   event_type: 'automation.action_requested',
//   payload: {
//     action: 'assign_coordinator',
//     entity_type: 'lead',
//     entity_id: 'lead-456',
//     params: { location_id: 'loc-34' },
//     dedup_key: 'evt-xyz-789-emit-assign',
//   },
// }
```

---

### `computeNextActiveWindowMs(config: ActiveHoursConfig, timezone: string, now?: Date): number`

Returns milliseconds until the next active window opens. Returns `0` if currently inside the window.

```ts
import { computeNextActiveWindowMs } from '@ortho/interpolator';
import type { ActiveHoursConfig } from '@ortho/interpolator';

const config: ActiveHoursConfig = { start: '08:00', end: '20:00' };

// Currently 10:00 in New York — inside window
computeNextActiveWindowMs(config, 'America/New_York', new Date('2026-03-31T14:00:00Z'));
// => 0

// Currently 22:00 in New York — outside window, ~10h until 08:00
computeNextActiveWindowMs(config, 'America/New_York', new Date('2026-04-01T02:00:00Z'));
// => ~36_000_000  (10 hours in ms)

// start === end means always-open
computeNextActiveWindowMs({ start: '00:00', end: '00:00' }, 'UTC');
// => 0

// Invalid timezone falls back to UTC with a console warning
computeNextActiveWindowMs(config, 'Invalid/Zone');
// Uses UTC, logs warning
```

**`ActiveHoursConfig` type:**

```ts
interface ActiveHoursConfig {
  start: string;  // HH:MM, 24-hour format
  end: string;    // HH:MM, 24-hour format
}
```

**Window semantics:**
- Non-crossing: `[start, end)` — e.g. 08:00-20:00
- Midnight-crossing: `[start, 24:00) + [00:00, end)` — e.g. 22:00-06:00
- Always-open: `start === end` returns 0
- Result is always in range `[0, 86_400_000]` (0 to 24 hours)

---

### `computeActiveHoursDelay(config: ActiveHoursFieldConfig, dataCtx: Record<string, unknown>, templateCtx: Record<string, unknown>, now?: Date): number`

**Automation Engine integration.** Resolves the timezone from the event payload via `config.timezone_field`, validates it, then delegates to `computeNextActiveWindowMs`. Falls back to UTC if the timezone is missing, empty, or invalid.

```ts
import { computeActiveHoursDelay } from '@ortho/interpolator';
import type { ActiveHoursFieldConfig } from '@ortho/interpolator';

const config: ActiveHoursFieldConfig = {
  start: '08:00',
  end: '20:00',
  timezone_field: 'payload.location_timezone',
};

const dataCtx = {
  payload: { location_timezone: 'America/Chicago' },
};

const templateCtx = { event_id: 'evt-123' };

computeActiveHoursDelay(config, dataCtx, templateCtx);
// => milliseconds until 08:00 Chicago time (0 if already inside window)
```

**`ActiveHoursFieldConfig` type:**

```ts
interface ActiveHoursFieldConfig {
  start: string;          // HH:MM, 24-hour format
  end: string;            // HH:MM, 24-hour format
  timezone_field: string; // dot-notation path resolved against dataCtx
}
```

---

## Consumer Guide

### Automation Engine

The Automation Engine uses the **dual-context API** (`resolveValue`, `resolveParams`, `computeActiveHoursDelay`). The `dataCtx` is the EventBridge event payload; the `templateCtx` contains execution metadata (`event_id`, `execution_id`, `rule_id`, `rule_version`).

```ts
// apps/platform/automation/src/services/action-workers/send-message.worker.ts
import { resolveParams, computeActiveHoursDelay } from '@ortho/interpolator';

const resolvedParams = resolveParams(step.action_params, event, templateCtx);
// resolvedParams.to_field is now '+15551234567', not 'payload.phone'

if (ruleSnapshot.active_hours) {
  const delayMs = computeActiveHoursDelay(ruleSnapshot.active_hours, event, templateCtx);
  if (delayMs > 0) {
    // Re-enqueue with delay
  }
}
```

### Nurturing Engine

The Nurturing Engine uses the **single-context API** (`interpolateValue`, `interpolateFields`, `computeNextActiveWindowMs`). The context is a merged object of enrollment context + step metadata.

```ts
// apps/platform/nurturing/src/services/step-worker.ts
import { interpolateFields, computeNextActiveWindowMs } from '@ortho/interpolator';

const merged = { context: enrollment.context, enrollment_id: enrollment.id };
const resolvedParams = interpolateFields(step.action_params, merged);

if (sequence.active_hours) {
  const tz = interpolateValue(sequence.active_hours.timezone_field, merged) as string;
  const delayMs = computeNextActiveWindowMs(sequence.active_hours, tz);
}
```

---

## Constraints and Gotchas

- **Single-context: single-word strings are literals.** `interpolateValue('haiku', ctx)` returns `'haiku'`, not `ctx.haiku`. A dot is required for path resolution. This prevents accidental lookups of short config values like model names.
- **Dual-context: single-segment strings resolve against dataCtx.** `resolveValue('status', dataCtx, templateCtx)` will look up `dataCtx.status`. This is safe because template tokens use `{{}}` syntax.
- **Missing paths return `undefined`.** `getByPath` returns `undefined` for any path that traverses through null, undefined, or a non-object. Callers must handle undefined if the path is optional.
- **Unresolved template tokens are preserved.** `"{{missing}}"` stays as `"{{missing}}"` in the output. This is intentional — it makes unresolved tokens visible for debugging rather than silently producing empty strings.
- **No circular reference detection.** The recursive walkers (`interpolateFields`, `resolveParams`) do not guard against circular objects. Callers are responsible for passing acyclic structures (which event payloads always are).
- **Timezone validation uses `Intl.DateTimeFormat`.** Invalid timezone strings trigger a fallback to UTC with a `console.warn`. The function never throws on bad timezone input.
- **Active hours result bounds.** `computeNextActiveWindowMs` always returns a value in `[0, 86_400_000]` — never negative, never more than 24 hours.
- **No external dependencies.** The package uses only built-in JavaScript APIs (`Intl.DateTimeFormat`, `String.prototype.replace`). No lodash, no date libraries.

---

## Consequences

**Good:**
- Both engines share identical interpolation semantics. A template token or dot-path behaves the same way in an automation rule and a nurturing sequence.
- All functions are pure — easy to unit test with no mocks, no I/O, no setup.
- Active-hours computation is timezone-aware using native `Intl` APIs — no `moment-timezone` or `luxon` dependency.

**Watch out for:**
- If a new engine or worker needs interpolation, it must choose between single-context and dual-context based on whether its execution metadata is merged into or separate from the data payload.
- Adding new interpolation forms (e.g. expression evaluation, filters) would require extending the regex patterns and resolver logic — keep the scope narrow.
