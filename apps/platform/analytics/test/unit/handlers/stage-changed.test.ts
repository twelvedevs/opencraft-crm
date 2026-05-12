import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';

const mockInsertEvent = vi.fn();
const mockUpsertPipelineDaily = vi.fn();
const mockUpsertCoordinatorDaily = vi.fn();

vi.mock('../../../src/repositories/events.js', () => ({
  insertEvent: mockInsertEvent,
}));

vi.mock('../../../src/repositories/rollups.js', () => ({
  upsertPipelineDaily: mockUpsertPipelineDaily,
  upsertCoordinatorDaily: mockUpsertCoordinatorDaily,
}));

const { handleStageChanged } = await import('../../../src/handlers/stage-changed.js');

function makePool(): Pool {
  const client = {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

const baseEvent: OrthoEvent = {
  event_id: 'evt-010',
  event_type: 'lead.stage_changed',
  entity_id: 'lead-010',
  payload: {
    occurred_at: '2026-01-20T09:00:00Z',
    location_id: 'loc-1',
    pipeline: 'new-patient',
    stage_to: 'contacted',
    triggered_by: 'coord-5',
    response_time_seconds: 120,
    time_in_stage_seconds: 300,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleStageChanged', () => {
  it('calls insertEvent with correct params', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertPipelineDaily.mockResolvedValue(undefined);
    mockUpsertCoordinatorDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleStageChanged(baseEvent, pool);

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [, params] = mockInsertEvent.mock.calls[0]!;
    expect(params.source).toBe('pipeline-engine');
    expect(params.entity_type).toBe('lead');
    expect(params.dimensions).toEqual({ location_id: 'loc-1', pipeline: 'new-patient', stage: 'contacted' });
  });

  it('calls upsertPipelineDaily and upsertCoordinatorDaily when inserted=true and triggered_by is set', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertPipelineDaily.mockResolvedValue(undefined);
    mockUpsertCoordinatorDaily.mockResolvedValue(undefined);
    const pool = makePool();

    await handleStageChanged(baseEvent, pool);

    expect(mockUpsertPipelineDaily).toHaveBeenCalledOnce();
    const [, pParams] = mockUpsertPipelineDaily.mock.calls[0]!;
    expect(pParams.date).toBe('2026-01-20');
    expect(pParams.location_id).toBe('loc-1');
    expect(pParams.pipeline).toBe('new-patient');
    expect(pParams.stage).toBe('contacted');
    expect(pParams.entries_delta).toBe(1);

    expect(mockUpsertCoordinatorDaily).toHaveBeenCalledOnce();
    const [, cParams] = mockUpsertCoordinatorDaily.mock.calls[0]!;
    expect(cParams.coordinator_id).toBe('coord-5');
    expect(cParams.response_time_sum_delta).toBe(120);
    expect(cParams.response_time_count_delta).toBe(1);
    expect(cParams.time_in_stage_sum_delta).toBe(300);
    expect(cParams.time_in_stage_count_delta).toBe(1);
  });

  it('skips coordinator rollup when triggered_by is absent', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertPipelineDaily.mockResolvedValue(undefined);
    const event: OrthoEvent = {
      ...baseEvent,
      payload: { ...baseEvent.payload, triggered_by: undefined },
    };
    const pool = makePool();

    await handleStageChanged(event, pool);

    expect(mockUpsertPipelineDaily).toHaveBeenCalledOnce();
    expect(mockUpsertCoordinatorDaily).not.toHaveBeenCalled();
  });

  it('sets response_time_sum_delta=0 and response_time_count_delta=0 when response_time_seconds is absent', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: true });
    mockUpsertPipelineDaily.mockResolvedValue(undefined);
    mockUpsertCoordinatorDaily.mockResolvedValue(undefined);
    const event: OrthoEvent = {
      ...baseEvent,
      payload: { ...baseEvent.payload, response_time_seconds: undefined },
    };
    const pool = makePool();

    await handleStageChanged(event, pool);

    const [, cParams] = mockUpsertCoordinatorDaily.mock.calls[0]!;
    expect(cParams.response_time_sum_delta).toBe(0);
    expect(cParams.response_time_count_delta).toBe(0);
  });

  it('skips both pipeline and coordinator rollups when inserted=false (duplicate event_id)', async () => {
    mockInsertEvent.mockResolvedValue({ inserted: false });
    const pool = makePool();

    await handleStageChanged(baseEvent, pool);

    expect(mockUpsertPipelineDaily).not.toHaveBeenCalled();
    expect(mockUpsertCoordinatorDaily).not.toHaveBeenCalled();
  });
});
