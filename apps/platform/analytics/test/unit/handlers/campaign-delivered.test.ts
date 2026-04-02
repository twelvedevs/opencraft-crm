import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';

const mockInsertEvent = vi.fn();
const mockUpsertCampaignDaily = vi.fn();

vi.mock('../../../src/repositories/events.js', () => ({
  insertEvent: mockInsertEvent,
}));

vi.mock('../../../src/repositories/rollups.js', () => ({
  upsertCampaignDaily: mockUpsertCampaignDaily,
}));

const { handleCampaignDelivered } = await import('../../../src/handlers/campaign-delivered.js');

function makePool(): Pool {
  const client = {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

const baseEvent: OrthoEvent = {
  event_id: 'evt-021',
  event_type: 'campaign.delivered',
  entity_id: 'campaign-1',
  payload: {
    occurred_at: '2026-03-01T07:30:00Z',
    campaign_id: 'camp-1',
    location_id: 'loc-1',
    recipient_count: 842,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleCampaignDelivered', () => {
  it('calls insertEvent with correct params', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertCampaignDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleCampaignDelivered(baseEvent, pool);

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [, params] = mockInsertEvent.mock.calls[0]!;
    expect(params.source).toBe('campaign-service');
    expect(params.entity_type).toBe('campaign');
  });

  it('calls upsertCampaignDaily with delivered_delta=recipient_count (842) when inserted=true', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertCampaignDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleCampaignDelivered(baseEvent, pool);

    expect(mockUpsertCampaignDaily).toHaveBeenCalledOnce();
    const [, params] = mockUpsertCampaignDaily.mock.calls[0]!;
    expect(params.date).toBe('2026-03-01');
    expect(params.campaign_id).toBe('camp-1');
    expect(params.location_id).toBe('loc-1');
    expect(params.delivered_delta).toBe(842);
  });

  it('defaults delivered_delta to 1 when recipient_count is absent', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertCampaignDaily.mockResolvedValue(undefined);
    const event: OrthoEvent = {
      ...baseEvent,
      payload: { ...baseEvent.payload, recipient_count: undefined },
    };
    const pool = makePool();

    await handleCampaignDelivered(event, pool);

    const [, params] = mockUpsertCampaignDaily.mock.calls[0]!;
    expect(params.delivered_delta).toBe(1);
  });

  it('skips upsertCampaignDaily when inserted=false', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: false });
    const pool = makePool();

    await handleCampaignDelivered(baseEvent, pool);

    expect(mockUpsertCampaignDaily).not.toHaveBeenCalled();
  });
});
