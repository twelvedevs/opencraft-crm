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

const { handleLeadArchived } = await import('../../../src/handlers/lead-archived.js');

function makePool(): Pool {
  const client = {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

const baseEvent: OrthoEvent = {
  event_id: 'evt-003',
  event_type: 'lead.archived',
  entity_id: 'lead-003',
  payload: {
    occurred_at: '2026-03-05T12:00:00Z',
    location_id: 'loc-3',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleLeadArchived', () => {
  it('calls insertEvent with correct params', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertLeadDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleLeadArchived(baseEvent, pool);

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [, params] = mockInsertEvent.mock.calls[0]!;
    expect(params.source).toBe('lead-service');
    expect(params.entity_type).toBe('lead');
    expect(params.dimensions).toEqual({ location_id: 'loc-3', channel: 'unknown' });
  });

  it('calls upsertLeadDaily with archived_delta=1 when inserted=true', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertLeadDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleLeadArchived(baseEvent, pool);

    expect(mockUpsertLeadDaily).toHaveBeenCalledOnce();
    const [, params] = mockUpsertLeadDaily.mock.calls[0]!;
    expect(params.date).toBe('2026-03-05');
    expect(params.location_id).toBe('loc-3');
    expect(params.channel).toBe('unknown');
    expect(params.archived_delta).toBe(1);
  });

  it('skips upsertLeadDaily when inserted=false', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: false });
    const pool = makePool();

    await handleLeadArchived(baseEvent, pool);

    expect(mockUpsertLeadDaily).not.toHaveBeenCalled();
  });
});
