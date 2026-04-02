import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';

const mockInsertEvent = vi.fn();
const mockUpsertLeadDaily = vi.fn();

vi.mock('../../../src/repositories/events.js', () => ({
  insertEvent: mockInsertEvent,
}));

vi.mock('../../../src/repositories/rollups.js', () => ({
  upsertLeadDaily: mockUpsertLeadDaily,
}));

const { handleLeadCreated } = await import('../../../src/handlers/lead-created.js');

function makePool(): Pool {
  const client = {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

const baseEvent: OrthoEvent = {
  event_id: 'evt-001',
  event_type: 'lead.created',
  entity_id: 'lead-001',
  payload: {
    occurred_at: '2026-01-15T10:00:00Z',
    location_id: 'loc-1',
    channel: 'google',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleLeadCreated', () => {
  it('calls insertEvent with correct params', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertLeadDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleLeadCreated(baseEvent, pool);

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [, params] = mockInsertEvent.mock.calls[0]!;
    expect(params.event_id).toBe('evt-001');
    expect(params.event_type).toBe('lead.created');
    expect(params.source).toBe('lead-service');
    expect(params.entity_type).toBe('lead');
    expect(params.dimensions).toEqual({ location_id: 'loc-1', channel: 'google' });
  });

  it('calls upsertLeadDaily with count_delta=1 when inserted=true', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertLeadDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleLeadCreated(baseEvent, pool);

    expect(mockUpsertLeadDaily).toHaveBeenCalledOnce();
    const [, params] = mockUpsertLeadDaily.mock.calls[0]!;
    expect(params.date).toBe('2026-01-15');
    expect(params.location_id).toBe('loc-1');
    expect(params.channel).toBe('google');
    expect(params.count_delta).toBe(1);
  });

  it('skips upsertLeadDaily when inserted=false (idempotency)', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: false });
    const pool = makePool();

    await handleLeadCreated(baseEvent, pool);

    expect(mockUpsertLeadDaily).not.toHaveBeenCalled();
  });

  it('defaults channel to "unknown" when payload.channel is absent', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertLeadDaily.mockResolvedValue(undefined);
    const event: OrthoEvent = {
      ...baseEvent,
      payload: { occurred_at: '2026-01-15T10:00:00Z', location_id: 'loc-1' },
    };
    const pool = makePool();

    await handleLeadCreated(event, pool);

    const [, params] = mockUpsertLeadDaily.mock.calls[0]!;
    expect(params.channel).toBe('unknown');
  });
});
