import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';

const mockInsertEvent = vi.fn();
const mockUpsertMessageDaily = vi.fn();

vi.mock('../../../src/repositories/events.js', () => ({
  insertEvent: mockInsertEvent,
}));

vi.mock('../../../src/repositories/rollups.js', () => ({
  upsertMessageDaily: mockUpsertMessageDaily,
}));

const { handleMessageDelivered } = await import('../../../src/handlers/message-delivered.js');

function makePool(): Pool {
  const client = {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

const baseEvent: OrthoEvent = {
  event_id: 'evt-040',
  event_type: 'message.delivered',
  entity_id: 'msg-1',
  payload: {
    occurred_at: '2026-01-10T11:00:00Z',
    location_id: 'loc-5',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleMessageDelivered', () => {
  it('calls insertEvent with correct params', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertMessageDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleMessageDelivered(baseEvent, pool);

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [, params] = mockInsertEvent.mock.calls[0]!;
    expect(params.source).toBe('messaging-service');
    expect(params.entity_type).toBe('message');
    expect(params.dimensions).toEqual({ location_id: 'loc-5' });
  });

  it('calls upsertMessageDaily with delivered_delta=1 when inserted=true', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertMessageDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleMessageDelivered(baseEvent, pool);

    expect(mockUpsertMessageDaily).toHaveBeenCalledOnce();
    const [, params] = mockUpsertMessageDaily.mock.calls[0]!;
    expect(params.date).toBe('2026-01-10');
    expect(params.location_id).toBe('loc-5');
    expect(params.delivered_delta).toBe(1);
  });

  it('skips upsertMessageDaily when inserted=false', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: false });
    const pool = makePool();

    await handleMessageDelivered(baseEvent, pool);

    expect(mockUpsertMessageDaily).not.toHaveBeenCalled();
  });
});
