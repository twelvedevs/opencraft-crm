import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';

const mockInsertEvent = vi.fn();
const mockUpsertReferralDaily = vi.fn();
const mockUpsertConversionDaily = vi.fn();

vi.mock('../../../src/repositories/events.js', () => ({
  insertEvent: mockInsertEvent,
}));

vi.mock('../../../src/repositories/rollups.js', () => ({
  upsertReferralDaily: mockUpsertReferralDaily,
  upsertConversionDaily: mockUpsertConversionDaily,
}));

const { handleReferralConverted } = await import('../../../src/handlers/referral-converted.js');

function makePool(): Pool {
  const client = {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

const baseEvent: OrthoEvent = {
  event_id: 'evt-050',
  event_type: 'referral.converted',
  entity_id: 'referral-1',
  payload: {
    occurred_at: '2026-02-14T10:00:00Z',
    location_id: 'loc-4',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleReferralConverted', () => {
  it('calls insertEvent with correct params', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertReferralDaily.mockResolvedValue(undefined);
    mockUpsertConversionDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleReferralConverted(baseEvent, pool);

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [, params] = mockInsertEvent.mock.calls[0]!;
    expect(params.source).toBe('referral-service');
    expect(params.entity_type).toBe('referral');
  });

  it('calls both upsertReferralDaily and upsertConversionDaily when inserted=true', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertReferralDaily.mockResolvedValue(undefined);
    mockUpsertConversionDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleReferralConverted(baseEvent, pool);

    expect(mockUpsertReferralDaily).toHaveBeenCalledOnce();
    const [, rParams] = mockUpsertReferralDaily.mock.calls[0]!;
    expect(rParams.date).toBe('2026-02-14');
    expect(rParams.location_id).toBe('loc-4');
    expect(rParams.count_delta).toBe(1);

    expect(mockUpsertConversionDaily).toHaveBeenCalledOnce();
    const [, cParams] = mockUpsertConversionDaily.mock.calls[0]!;
    expect(cParams.date).toBe('2026-02-14');
    expect(cParams.location_id).toBe('loc-4');
    expect(cParams.channel).toBe('referral');
    expect(cParams.count_delta).toBe(1);
  });

  it('skips both upserts when inserted=false (duplicate event_id)', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: false });
    const pool = makePool();

    await handleReferralConverted(baseEvent, pool);

    expect(mockUpsertReferralDaily).not.toHaveBeenCalled();
    expect(mockUpsertConversionDaily).not.toHaveBeenCalled();
  });
});
