# ADR: @ortho/event-bus — Typed Event Bus Package

**Date:** 2026-03-30
**Status:** Accepted
**Package:** `packages/@ortho/event-bus`

---

## Context

Ortho CRM services communicate asynchronously through domain events (see `docs/01-platform-arch-design.md`, §3.1). The event bus package provides:

- A single typed API that all services use to publish and subscribe to events
- Pluggable drivers so the same code runs against AWS EventBridge (production), Redis Streams (local/integration tests), or an in-memory mock (unit tests)
- Consistent envelope fields (`correlation_id`, `causation_id`, `schema_version`) for tracing and versioning

The driver is selected at runtime via environment variable — no code changes required between environments.

---

## Decision

Provide `@ortho/event-bus` with a stable `EventBus` interface backed by swappable `Driver` implementations. Services call `createEventBus()` at startup; the factory reads `EVENT_BUS_DRIVER` and wires the appropriate driver.

---

## Core Types

### `OrthoEvent`

The canonical event envelope. Every published and received event conforms to this shape.

```ts
interface OrthoEvent {
  event_type: string;           // e.g. "lead.created", "message.delivered"
  entity_type?: string;         // e.g. "lead", "conversation"
  entity_id?: string;           // UUID of the entity
  payload: Record<string, unknown>; // event-specific data
  correlation_id?: string;      // traces a request across multiple services
  causation_id?: string;        // event_id of the event that caused this one
  schema_version?: string;      // e.g. "1.0" — for future schema evolution
}
```

### `EventBus`

The interface every service interacts with. Never instantiate `EventBusImpl` directly — use `createEventBus()`.

```ts
interface EventBus {
  subscribe(eventType: string, handler: EventHandler): void;
  publish(event: OrthoEvent): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### `EventHandler`

```ts
type EventHandler = (event: OrthoEvent) => Promise<void>;
```

---

## API

### `createEventBus(options?: EventBusOptions): EventBus`

Factory function. Returns a fully configured `EventBus` instance.

**Behaviour:**

1. If `options.driver` is provided, it is used directly (useful in tests).
2. Otherwise reads `EVENT_BUS_DRIVER` environment variable:
   - `"eventbridge"` → `EventBridgeDriver` (production; requires `EVENT_BRIDGE_BUS_NAME` + `SQS_QUEUE_URL`)
   - `"redis"` → `RedisStreamsDriver` (local dev/integration; requires `REDIS_URL` + `EVENT_BUS_CONSUMER_GROUP`)
3. Throws if `EVENT_BUS_DRIVER` is not set or is not a recognised value.

**Parameters**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `options.driver` | `Driver` | No | Override driver (skips env-var lookup) |

---

### `bus.subscribe(eventType, handler)`

Registers a handler for an event type. **Must be called before `bus.start()`**. Calling it after `start()` throws.

Multiple handlers for the same `event_type` are supported — all are called in registration order.

---

### `bus.publish(event)`

Sends an event to the underlying transport. Returns a promise that resolves when the transport has accepted the message.

---

### `bus.start()`

Begins consuming messages from the transport. Warns if called with zero subscriptions. After `start()` returns, the bus is actively polling/streaming.

---

### `bus.stop()`

Signals the consumer loop to exit and waits for it to drain. Safe to call multiple times.

---

## Drivers

### EventBridgeDriver (production)

Backed by an **SQS FIFO queue** that receives messages from EventBridge. Uses long-polling (20 s). Messages are deleted from the queue only after all handlers succeed; on handler failure, the message remains in the queue for SQS's built-in visibility timeout to return it.

**Environment variables required:**

| Variable | Description |
|----------|-------------|
| `EVENT_BRIDGE_BUS_NAME` | Name of the EventBridge bus (used for validation; actual delivery is via SQS) |
| `SQS_QUEUE_URL` | Full URL of the FIFO SQS queue |

**Ordering:** `MessageGroupId` is set to `entity_id` (when present) or `event_type`. Within a group, ordering is preserved.

---

### RedisStreamsDriver (local dev / integration tests)

Backed by **Redis Streams** with consumer groups. One stream per `event_type` (`stream:<event_type>`). Provides at-least-once delivery with a dead-letter queue.

**Environment variables required:**

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection URL (e.g. `redis://localhost:6379`) |
| `EVENT_BUS_CONSUMER_GROUP` | Consumer group name — typically the service name (e.g. `automation`) |

**Dead-letter queue:** Messages that fail handler processing 3 or more times are moved to `stream:dlq` and acknowledged, preventing indefinite retries.

**Consumer lag:** Logs a warning when pending message count exceeds 1000 for any stream+group pair.

---

### MockDriver (unit tests)

In-memory driver. Collects published events in `driver.published: OrthoEvent[]` for assertions. Subscriptions are registered but never invoked automatically (tests trigger handlers directly or use integration test harnesses).

```ts
import { MockDriver, createEventBus } from '@ortho/event-bus';

const driver = new MockDriver();
const bus = createEventBus({ driver });
```

---

## Configuration Reference

| Environment Variable | Required by | Description |
|----------------------|-------------|-------------|
| `EVENT_BUS_DRIVER` | All (except explicit driver injection) | `"eventbridge"` or `"redis"` |
| `EVENT_BRIDGE_BUS_NAME` | EventBridgeDriver | EventBridge bus name |
| `SQS_QUEUE_URL` | EventBridgeDriver | SQS FIFO queue URL |
| `REDIS_URL` | RedisStreamsDriver | Redis connection URL |
| `EVENT_BUS_CONSUMER_GROUP` | RedisStreamsDriver | Consumer group name |

---

## Examples

### 1. Service startup — subscribe then start

All subscriptions must be registered before calling `start()`.

```ts
// apps/platform/automation/src/index.ts
import { createEventBus } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { handleLeadCreated } from './handlers/lead-created.js';
import { handleLeadStageChanged } from './handlers/lead-stage-changed.js';

const log = createLogger('automation');
const bus = createEventBus(); // reads EVENT_BUS_DRIVER from env

bus.subscribe('lead.created', handleLeadCreated);
bus.subscribe('lead.stage_changed', handleLeadStageChanged);
bus.subscribe('message.received', async (event) => {
  log.info({ entityId: event.entity_id }, 'inbound message received');
  // ...
});

await bus.start();
log.info('event bus started');

// On shutdown:
process.on('SIGTERM', async () => {
  await bus.stop();
  process.exit(0);
});
```

### 2. Publishing an event

```ts
// apps/crm/lead/src/services/lead-service.ts
import { createEventBus } from '@ortho/event-bus';
import { randomUUID } from 'crypto';

const bus = createEventBus();

export async function createLead(input: CreateLeadInput) {
  const lead = await db.leads.insert(input);

  await bus.publish({
    event_type: 'lead.created',
    entity_type: 'lead',
    entity_id: lead.id,
    payload: {
      locationId: lead.locationId,
      channel: lead.channel,
      name: lead.name,
    },
    correlation_id: randomUUID(),
    schema_version: '1.0',
  });

  return lead;
}
```

### 3. Chaining causation across events

When a handler publishes a downstream event, pass the incoming event's ID as `causation_id` so the event chain is traceable.

```ts
// apps/platform/automation/src/handlers/lead-created.ts
import type { OrthoEvent } from '@ortho/event-bus';

export async function handleLeadCreated(event: OrthoEvent): Promise<void> {
  const workflows = await workflowRepo.findTriggeredBy('lead.created');

  for (const workflow of workflows) {
    await bus.publish({
      event_type: 'workflow.triggered',
      entity_type: 'workflow',
      entity_id: workflow.id,
      payload: {
        triggerEvent: event.event_type,
        entityId: event.entity_id,
      },
      correlation_id: event.correlation_id,
      causation_id: event.entity_id, // the lead ID that caused this workflow run
      schema_version: '1.0',
    });
  }
}
```

### 4. Unit test with MockDriver

```ts
// test/unit/lead-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MockDriver, createEventBus } from '@ortho/event-bus';
import { LeadService } from '../../src/services/lead-service.js';

describe('LeadService.create', () => {
  let driver: MockDriver;
  let service: LeadService;

  beforeEach(() => {
    driver = new MockDriver();
    const bus = createEventBus({ driver });
    service = new LeadService(bus, mockLeadRepo);
  });

  it('publishes lead.created after insert', async () => {
    await service.create({ name: 'Jane', locationId: 'loc-1', channel: 'web' });

    expect(driver.published).toHaveLength(1);
    expect(driver.published[0]).toMatchObject({
      event_type: 'lead.created',
      entity_type: 'lead',
      payload: { locationId: 'loc-1', channel: 'web' },
    });
  });
});
```

### 5. Integration test with RedisStreamsDriver

```ts
// test/integration/event-bus.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEventBus } from '@ortho/event-bus';

describe('RedisStreamsDriver integration', () => {
  const publishBus = createEventBus();   // EVENT_BUS_DRIVER=redis in test env
  const consumeBus = createEventBus();

  const received: unknown[] = [];

  beforeAll(async () => {
    consumeBus.subscribe('test.ping', async (event) => {
      received.push(event);
    });
    await consumeBus.start();
  });

  afterAll(async () => {
    await consumeBus.stop();
  });

  it('consumer receives published event', async () => {
    await publishBus.publish({
      event_type: 'test.ping',
      payload: { ts: Date.now() },
    });

    // Allow stream read loop to pick up the message
    await new Promise((r) => setTimeout(r, 500));

    expect(received).toHaveLength(1);
  });
});
```

---

## Constraints and Gotchas

- **`subscribe` before `start`:** Calling `subscribe()` after `start()` throws. Register all handlers at startup before calling `start()`.
- **At-least-once delivery:** Both drivers can deliver a message more than once (network retries, SQS visibility timeout expiry). Handlers must be idempotent.
- **No wildcard subscriptions:** The `eventType` argument to `subscribe` must be an exact string match (e.g. `"lead.created"`). There is no glob or pattern support.
- **Handler errors cause re-delivery (EventBridge):** If any handler throws, the SQS message is not deleted and will be redelivered after the visibility timeout. Fix the handler or add dead-letter queue configuration at the SQS level for persistent failures.
- **Handler errors after 3 attempts go to DLQ (Redis):** After 3 delivery failures the message is written to `stream:dlq` and acknowledged. Monitor `stream:dlq` in production.
- **`start()` with zero subscriptions:** Logs a warning and returns without connecting to the transport. This is valid for publish-only services (e.g. Pipeline Engine publishes but doesn't subscribe).

---

## Consequences

**Good:**
- Services never depend on a specific transport. Switching from Redis to EventBridge requires only an env var change and a redeployment.
- Unit tests run with `MockDriver` — no Docker, no network, no flakiness.
- Local dev and integration tests run with `RedisStreamsDriver` and a local Redis — identical semantics to production without an AWS account.

**Watch out for:**
- Do not share a single `EventBus` instance across multiple services in a monorepo test setup — each service should have its own instance with its own consumer group.
- The `MockDriver` does not invoke subscribers automatically. It only records published events. For end-to-end handler testing, use `RedisStreamsDriver` in integration tests.
