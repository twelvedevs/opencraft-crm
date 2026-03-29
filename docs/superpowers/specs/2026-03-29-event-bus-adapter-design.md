# Event Bus Adapter — Design Spec

**Date:** 2026-03-29
**Status:** Approved
**Scope:** `packages/@ortho/event-bus` — pluggable event bus with EventBridge (production) and Redis Streams (local/CI) drivers

---

## 1. Overview

All services communicate asynchronously via a shared `EventBus` abstraction in `packages/@ortho/event-bus`. The active transport is selected at runtime via `EVENT_BUS_DRIVER`. In production, events flow through AWS EventBridge + SQS. In local development and CI, they flow through Redis Streams — reusing the Redis container already present for BullMQ, with no new dependencies.

Services never import driver code directly. They call `createEventBus()`, `publish()`, `subscribe()`, and `start()` — the driver is an implementation detail.

---

## 2. Package Structure

```
packages/@ortho/event-bus/
├── src/
│   ├── index.ts              # public exports: createEventBus, EventBus, OrthoEvent, EventHandler, Driver
│   ├── types.ts              # OrthoEvent, EventHandler, EventBus interface, Driver interface
│   ├── factory.ts            # createEventBus() — reads EVENT_BUS_DRIVER, constructs driver
│   └── drivers/
│       ├── eventbridge.ts    # EventBridgeDriver
│       └── redis-streams.ts  # RedisStreamsDriver
├── package.json
└── tsconfig.json
```

---

## 3. Core Types

```typescript
// types.ts

export interface OrthoEvent {
  event_type: string;            // e.g. "lead.created", "lead.stage_changed"
  entity_type?: string;          // e.g. "lead"
  entity_id?: string;            // UUID of the entity
  payload: Record<string, unknown>;
}

export type EventHandler = (event: OrthoEvent) => Promise<void>;

export interface EventBus {
  publish(event: OrthoEvent): Promise<void>;
  subscribe(eventType: string, handler: EventHandler): void;  // synchronous, registers in-memory
  start(): Promise<void>;   // begins polling / consuming loops
  stop(): Promise<void>;    // graceful shutdown
}

// Internal interface — also exported for test injection
export interface Driver {
  publish(event: OrthoEvent): Promise<void>;
  start(subscriptions: Map<string, EventHandler>): Promise<void>;
  stop(): Promise<void>;
}
```

---

## 4. Factory

```typescript
// factory.ts

export interface EventBusOptions {
  driver?: Driver;  // injectable for tests
}

export function createEventBus(options?: EventBusOptions): EventBus
```

`createEventBus` reads `EVENT_BUS_DRIVER`:

| Value | Driver instantiated |
|-------|---------------------|
| `eventbridge` | `EventBridgeDriver` |
| `redis` | `RedisStreamsDriver` |
| _(absent)_ | Throws with a clear error message |

If `options.driver` is provided it is used directly, bypassing env var lookup — this is the test injection path.

---

## 5. EventBridgeDriver (production)

**Config env vars:** `EVENT_BRIDGE_BUS_NAME`, `SQS_QUEUE_URL`

### Publishing

Calls `PutEvents` via `@aws-sdk/client-eventbridge`:

```
Source:     "ortho"
EventBusName: EVENT_BRIDGE_BUS_NAME
DetailType: event.event_type
Detail:     JSON.stringify(event)
```

### Consuming

SQS long-poll loop started by `start()`:

1. `ReceiveMessage` — up to 10 messages, `WaitTimeSeconds: 20`
2. Parse `Detail` field back to `OrthoEvent`
3. Look up handler by `event_type`; if no handler registered, delete message (not subscribed)
4. Call handler — on success: `DeleteMessage`
5. On handler throw: do **not** delete — SQS visibility timeout expires, message redelivered; goes to DLQ after the queue's configured `maxReceiveCount`

`stop()` sets a shutdown flag; the poll loop exits after the current receive completes.

---

## 6. RedisStreamsDriver (local / CI)

**Config env vars:** `REDIS_URL`, `EVENT_BUS_CONSUMER_GROUP` (e.g. `automation-engine`)

### Publishing

```
XADD stream:{event.event_type} MAXLEN ~ 10000 * <serialized event fields>
```

One stream per event type: `stream:lead.created`, `stream:lead.stage_changed`, etc.

### Consuming

`start()` iterates over all registered subscriptions and launches one `XREADGROUP` loop per event type:

1. `XGROUP CREATE stream:{eventType} {GROUP} $ MKSTREAM` — idempotent, ignores `BUSYGROUP` error
2. Loop: `XREADGROUP GROUP {GROUP} {consumer-id} COUNT 10 BLOCK 2000 STREAMS stream:{eventType} >`
3. On message received: deserialize → call handler → `XACK stream:{eventType} {GROUP} {id}` on success
4. On handler throw: no `XACK` — message stays pending, redelivered on next restart
5. After 3 delivery attempts (checked via `XPENDING`): move message to `stream:dlq` then `XACK` to prevent infinite retry

Consumer ID = `{GROUP}-{hostname}-{pid}` to support multiple instances.

`stop()` sets a shutdown flag; all XREADGROUP loops exit after their current `BLOCK` timeout (≤ 2s).

---

## 7. Service Usage

### Publisher-only service (e.g. Pipeline Engine, Lead Service)

```typescript
const bus = createEventBus();

await bus.publish({
  event_type: 'lead.stage_changed',
  entity_type: 'lead',
  entity_id: leadId,
  payload: { from: 'new_lead', to: 'contacted', reason: 'manual' },
});
```

No `start()` call needed.

### Consumer service (Automation Engine)

```typescript
const bus = createEventBus();

bus.subscribe('lead.created', async (event) => { /* rule matching */ });
bus.subscribe('lead.stage_changed', async (event) => { /* rule matching */ });
bus.subscribe('lead.stage_timeout', async (event) => { /* rule matching */ });

await bus.start();

// SIGTERM handler
process.on('SIGTERM', async () => {
  await bus.stop();
  // ... close workers, db
});
```

---

## 8. Environment Variables

| Variable | Driver | Required for | Example |
|----------|--------|--------------|---------|
| `EVENT_BUS_DRIVER` | both | all services | `redis` / `eventbridge` |
| `EVENT_BRIDGE_BUS_NAME` | EventBridge | all services in prod | `ortho-events` |
| `SQS_QUEUE_URL` | EventBridge | consumer services in prod | `https://sqs.us-east-1...` |
| `REDIS_URL` | Redis | all services local/CI | `redis://localhost:6379` |
| `EVENT_BUS_CONSUMER_GROUP` | Redis | consumer services | `automation-engine` |

### Local `.env.local`

```
EVENT_BUS_DRIVER=redis
REDIS_URL=redis://localhost:6379
EVENT_BUS_CONSUMER_GROUP=automation-engine
```

Redis is already present in docker-compose for BullMQ — no new container required.

---

## 9. Testing

The `Driver` interface is exported from `@ortho/event-bus`, enabling a `MockDriver` for unit tests with no real infrastructure:

```typescript
const mock = new MockDriver();
const bus = createEventBus({ driver: mock });
```

- **Unit tests** (all services): inject `MockDriver`, assert `publish` was called with correct shape
- **Integration tests** (Automation Engine): use `RedisStreamsDriver` against the test Redis container already used by BullMQ tests
- **No LocalStack required** for CI

---

## 10. Migration: Automation Engine SQS Poller

The Automation Engine currently owns (or will own per Phase 3) its own SQS polling loop. That loop moves into `EventBridgeDriver`. The engine's event consumer becomes:

```typescript
bus.subscribe('lead.created', this.handleEvent.bind(this));
await bus.start();
```

The polling, message deletion, and error handling are no longer the engine's concern.
