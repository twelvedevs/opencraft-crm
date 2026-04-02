import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';

const mockInsertEvent = vi.fn();
const mockUpsertAdSpendDaily = vi.fn();

vi.mock('../../../src/repositories/events.js', () => ({
  insertEvent: mockInsertEvent,
}));

vi.mock('../../../src/repositories/rollups.js', () => ({
  upsertAdSpendDaily: mockUpsertAdSpendDaily,
}));

const { handleAdSpendSynced } = await import('../../../src/handlers/ad-spend-synced.js');

function makePool(): Pool {
  const client = {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

const baseEvent: OrthoEvent = {
  event_id: 'evt-060',
  event_type: 'integration.ad_spend_synced',
  entity_id: 'sync-1',
  payload: {
    occurred_at: '2026-03-10T06:00:00Z',
    platform: 'google',
    location_id: 'loc-1',
    synced_date: '2026-03-09',
    records: [
      { campaign_id: 'c1', campaign_name: 'Spring Promo', impressions: 1000, clicks: 50, spend: 200.0 },
      { campaign_id: 'c2', campaign_name: 'Summer Sale', impressions: 500, clicks: 20, spend: 80.0 },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleAdSpendSynced', () => {
  it('calls insertEvent with correct params', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertAdSpendDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleAdSpendSynced(baseEvent, pool);

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [, params] = mockInsertEvent.mock.calls[0]!;
    expect(params.source).toBe('integration-hub');
    expect(params.entity_type).toBe('ad-spend');
    expect(params.dimensions).toEqual({ platform: 'google', location_id: 'loc-1' });
  });

  it('calls upsertAdSpendDaily once per record when inserted=true', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertAdSpendDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleAdSpendSynced(baseEvent, pool);

    expect(mockUpsertAdSpendDaily).toHaveBeenCalledTimes(2);
    const [, first] = mockUpsertAdSpendDaily.mock.calls[0]!;
    expect(first.date).toBe('2026-03-09');
    expect(first.platform).toBe('google');
    expect(first.campaign_id).toBe('c1');
    expect(first.impressions).toBe(1000);
    expect(first.spend).toBe(200.0);
  });

  it('calls upsertAdSpendDaily even when inserted=false (relaxed idempotency)', async () => {
    // Relaxed: ad spend rows always overwrite, allowing corrected figures to be re-published
    mockInsertEvent.mockResolvedValue({ inserted: false });
    mockUpsertAdSpendDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleAdSpendSynced(baseEvent, pool);

    expect(mockUpsertAdSpendDaily).toHaveBeenCalledTimes(2);
  });

  it('handles empty records array gracefully', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    const event: OrthoEvent = { ...baseEvent, payload: { ...baseEvent.payload, records: [] } };
    const pool = makePool();

    await handleAdSpendSynced(event, pool);

    expect(mockUpsertAdSpendDaily).not.toHaveBeenCalled();
  });
});
