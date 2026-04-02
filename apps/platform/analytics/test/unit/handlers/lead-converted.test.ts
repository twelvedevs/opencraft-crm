import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';

const mockInsertEvent = vi.fn();
const mockUpsertConversionDaily = vi.fn();

vi.mock('../../../src/repositories/events.js', () => ({
  insertEvent: mockInsertEvent,
}));

vi.mock('../../../src/repositories/rollups.js', () => ({
  upsertConversionDaily: mockUpsertConversionDaily,
}));

const { handleLeadConverted } = await import('../../../src/handlers/lead-converted.js');

function makePool(): Pool {
  const client = {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

const baseEvent: OrthoEvent = {
  event_id: 'evt-002',
  event_type: 'lead.converted',
  entity_id: 'lead-002',
  payload: {
    occurred_at: '2026-02-10T08:00:00Z',
    location_id: 'loc-2',
    channel: 'facebook',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleLeadConverted', () => {
  it('calls insertEvent with correct params', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertConversionDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleLeadConverted(baseEvent, pool);

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [, params] = mockInsertEvent.mock.calls[0]!;
    expect(params.event_id).toBe('evt-002');
    expect(params.source).toBe('lead-service');
    expect(params.dimensions).toEqual({ location_id: 'loc-2', channel: 'facebook' });
  });

  it('calls upsertConversionDaily with count_delta=1 when inserted=true', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertConversionDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleLeadConverted(baseEvent, pool);

    expect(mockUpsertConversionDaily).toHaveBeenCalledOnce();
    const [, params] = mockUpsertConversionDaily.mock.calls[0]!;
    expect(params.date).toBe('2026-02-10');
    expect(params.location_id).toBe('loc-2');
    expect(params.channel).toBe('facebook');
    expect(params.count_delta).toBe(1);
  });

  it('skips upsertConversionDaily when inserted=false', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: false });
    const pool = makePool();

    await handleLeadConverted(baseEvent, pool);

    expect(mockUpsertConversionDaily).not.toHaveBeenCalled();
  });
});
