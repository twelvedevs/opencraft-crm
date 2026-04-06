import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import { createEventWorker } from '../../src/workers/event-worker.js';

// Minimal driver that captures subscriptions and lets tests trigger events
class TestDriver {
  private subscriptions = new Map<string, (event: unknown) => Promise<void>>();

  async start(subs: Map<string, (event: unknown) => Promise<void>[]>): Promise<void> {
    // Flatten: take first handler per event type (wrapHandler registers one per type)
    for (const [type, handlers] of subs) {
      if (handlers.length > 0) {
        this.subscriptions.set(type, handlers[0] as (event: unknown) => Promise<void>);
      }
    }
  }

  async stop(): Promise<void> {}

  async trigger(eventType: string, event: unknown): Promise<void> {
    const handler = this.subscriptions.get(eventType);
    if (handler) {
      await handler(event);
    }
  }
}

// We can't easily unit-test wrapHandler in isolation without importing internal
// symbols, so we verify the re-throw behaviour via a thin integration of
// createEventWorker + a throwing handler mock.

vi.mock('../../src/workers/handlers/lead-archived.js', () => ({
  handleLeadArchived: vi.fn(),
}));

import { handleLeadArchived } from '../../src/workers/handlers/lead-archived.js';

// The event-bus package — mock createEventBus to return a controllable bus
vi.mock('@ortho/event-bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ortho/event-bus')>();
  return {
    ...actual,
    createEventBus: vi.fn(),
  };
});

import { createEventBus, type EventBus } from '@ortho/event-bus';

const makeEvent = () => ({
  event_id: 'evt-1',
  event_type: 'lead.archived',
  entity_type: 'lead',
  entity_id: 'lead-1',
  timestamp: new Date().toISOString(),
  payload: { lead_id: 'lead-1' },
});

describe('wrapHandler error re-throw', () => {
  let subscribedHandlers: Map<string, Array<(event: unknown) => Promise<void>>>;
  let mockBus: Partial<EventBus>;

  beforeEach(() => {
    vi.clearAllMocks();
    subscribedHandlers = new Map();

    // Build a mock bus that captures subscriptions and exposes them
    mockBus = {
      subscribe: vi.fn((eventType: string, handler: (event: unknown) => Promise<void>) => {
        const handlers = subscribedHandlers.get(eventType) ?? [];
        handlers.push(handler);
        subscribedHandlers.set(eventType, handlers);
      }),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(createEventBus).mockReturnValue(mockBus as EventBus);
  });

  it('re-throws handler errors so the bus driver can retry/DLQ', async () => {
    const handlerError = new Error('transient DB failure');
    vi.mocked(handleLeadArchived).mockRejectedValue(handlerError);

    const db = {} as Knex;
    createEventWorker(db);

    // Grab the subscribed handler for 'lead.archived'
    const [wrappedHandler] = subscribedHandlers.get('lead.archived') ?? [];
    expect(wrappedHandler).toBeDefined();

    await expect(wrappedHandler(makeEvent())).rejects.toThrow('transient DB failure');
  });

  it('does not re-throw when handler succeeds', async () => {
    vi.mocked(handleLeadArchived).mockResolvedValue(undefined);

    const db = {} as Knex;
    createEventWorker(db);

    const [wrappedHandler] = subscribedHandlers.get('lead.archived') ?? [];
    await expect(wrappedHandler(makeEvent())).resolves.toBeUndefined();
  });
});
