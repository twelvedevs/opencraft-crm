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

const { handleCampaignSent } = await import('../../../src/handlers/campaign-sent.js');

function makePool(): Pool {
  const client = {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

const baseEvent: OrthoEvent = {
  event_id: 'evt-020',
  event_type: 'campaign.sent',
  entity_id: 'campaign-1',
  payload: {
    occurred_at: '2026-03-01T07:00:00Z',
    campaign_id: 'camp-1',
    location_id: 'loc-1',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleCampaignSent', () => {
  it('calls insertEvent with correct params', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertCampaignDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleCampaignSent(baseEvent, pool);

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [, params] = mockInsertEvent.mock.calls[0]!;
    expect(params.source).toBe('campaign-service');
    expect(params.entity_type).toBe('campaign');
    expect(params.dimensions).toEqual({ campaign_id: 'camp-1', location_id: 'loc-1' });
  });

  it('calls upsertCampaignDaily with sent_delta=1 when inserted=true', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertCampaignDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleCampaignSent(baseEvent, pool);

    expect(mockUpsertCampaignDaily).toHaveBeenCalledOnce();
    const [, params] = mockUpsertCampaignDaily.mock.calls[0]!;
    expect(params.date).toBe('2026-03-01');
    expect(params.campaign_id).toBe('camp-1');
    expect(params.location_id).toBe('loc-1');
    expect(params.sent_delta).toBe(1);
  });

  it('skips upsertCampaignDaily when inserted=false', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: false });
    const pool = makePool();

    await handleCampaignSent(baseEvent, pool);

    expect(mockUpsertCampaignDaily).not.toHaveBeenCalled();
  });
});
