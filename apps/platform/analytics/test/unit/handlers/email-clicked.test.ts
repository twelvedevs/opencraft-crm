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

const { handleEmailClicked } = await import('../../../src/handlers/email-clicked.js');

function makePool(): Pool {
  const client = {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

const baseEvent: OrthoEvent = {
  event_id: 'evt-031',
  event_type: 'email.clicked',
  entity_id: 'email-2',
  payload: {
    occurred_at: '2026-03-02T09:00:00Z',
    campaign_id: 'camp-2',
    location_id: 'loc-2',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleEmailClicked', () => {
  it('calls insertEvent with entity_type=email', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertCampaignDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleEmailClicked(baseEvent, pool);

    const [, params] = mockInsertEvent.mock.calls[0]!;
    expect(params.entity_type).toBe('email');
    expect(params.source).toBe('campaign-service');
  });

  it('calls upsertCampaignDaily with clicked_delta=1 when inserted=true', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertCampaignDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleEmailClicked(baseEvent, pool);

    expect(mockUpsertCampaignDaily).toHaveBeenCalledOnce();
    const [, params] = mockUpsertCampaignDaily.mock.calls[0]!;
    expect(params.clicked_delta).toBe(1);
    expect(params.campaign_id).toBe('camp-2');
    expect(params.date).toBe('2026-03-02');
  });

  it('skips upsertCampaignDaily when inserted=false', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: false });
    const pool = makePool();

    await handleEmailClicked(baseEvent, pool);

    expect(mockUpsertCampaignDaily).not.toHaveBeenCalled();
  });
});
