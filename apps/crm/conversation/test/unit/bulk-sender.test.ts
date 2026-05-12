import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from 'knex';

vi.mock('../../src/repositories/bulk-send-jobs.repo.js', () => ({
  updateStatus: vi.fn(),
}));

vi.mock('../../src/repositories/settings.repo.js', () => ({
  getEffectiveSettings: vi.fn(),
}));

vi.mock('../../src/lib/service-client.js', () => ({
  leadClient: { get: vi.fn(), post: vi.fn() },
  audienceClient: { get: vi.fn(), post: vi.fn() },
  messagingClient: { get: vi.fn(), post: vi.fn() },
}));

import { executeBulkSend } from '../../src/services/bulk-sender.js';
import * as bulkSendJobsRepo from '../../src/repositories/bulk-send-jobs.repo.js';
import * as settingsRepo from '../../src/repositories/settings.repo.js';
import { leadClient, audienceClient, messagingClient } from '../../src/lib/service-client.js';

const mockDb = {} as Knex;

const makeLead = (id: string) => ({
  id,
  phone: `+155500000${id.padStart(2, '0')}`,
  current_stage: 'new_lead',
  current_pipeline: 'new_patient',
  created_at: '2026-04-01T00:00:00Z',
  tags: [],
});

describe('bulk-sender executeBulkSend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bulkSendJobsRepo.updateStatus).mockResolvedValue(undefined);
    vi.mocked(settingsRepo.getEffectiveSettings).mockResolvedValue({
      practice_number: '+15551234567',
      business_hours: {},
      agent_enabled: false,
      agent_exchange_limit: 3,
    } as unknown as Awaited<ReturnType<typeof settingsRepo.getEffectiveSettings>>);
    vi.mocked(messagingClient.post).mockResolvedValue({ message_id: 'ext-msg' });
  });

  it('paginates through multiple pages of leads using nextCursor and terminates when null', async () => {
    const page1 = [makeLead('1'), makeLead('2')];
    const page2 = [makeLead('3'), makeLead('4')];

    vi.mocked(leadClient.get)
      .mockResolvedValueOnce({ data: page1, nextCursor: 'abc' })
      .mockResolvedValueOnce({ data: page2, nextCursor: null });

    // Audience engine: match all 4 leads so we can verify which ones were loaded.
    vi.mocked(audienceClient.post).mockResolvedValue({
      matched_entity_ids: ['1', '2', '3', '4'],
    });

    await executeBulkSend(mockDb, 'job-1', {
      locationId: 'loc-1',
      segment: {},
      body: 'Hello',
    });

    // leadClient.get must have been called twice: once without cursor, once with cursor=abc.
    const getCalls = vi.mocked(leadClient.get).mock.calls;
    expect(getCalls).toHaveLength(2);
    expect(getCalls[0][0]).toBe('/leads');
    expect(getCalls[0][1]).not.toHaveProperty('cursor');
    expect(getCalls[1][1]).toMatchObject({ cursor: 'abc' });

    // Audience evaluate must have received entities from BOTH pages (4 total).
    const audiencePostCalls = vi.mocked(audienceClient.post).mock.calls;
    expect(audiencePostCalls).toHaveLength(1);
    const entities = (audiencePostCalls[0][1] as { entities: Array<{ id: string }> }).entities;
    expect(entities.map((e) => e.id).sort()).toEqual(['1', '2', '3', '4']);

    // Each matched lead got a messagingClient.post call (page 2 leads included).
    expect(vi.mocked(messagingClient.post)).toHaveBeenCalledTimes(4);
    const sentTo = vi
      .mocked(messagingClient.post)
      .mock.calls.map((c) => (c[1] as { to: string }).to)
      .sort();
    expect(sentTo).toContain('+15550000003'); // page 2 lead
    expect(sentTo).toContain('+15550000004'); // page 2 lead

    // Job completed with correct totals.
    expect(bulkSendJobsRepo.updateStatus).toHaveBeenCalledWith(
      mockDb,
      'job-1',
      'completed',
      expect.objectContaining({ sent: 4, failed: 0 }),
    );
  });

  it('terminates the pagination loop when nextCursor is null on the first response (not via some other signal)', async () => {
    vi.mocked(leadClient.get).mockResolvedValueOnce({
      data: [makeLead('1')],
      nextCursor: null,
    });
    vi.mocked(audienceClient.post).mockResolvedValue({ matched_entity_ids: ['1'] });

    await executeBulkSend(mockDb, 'job-2', {
      locationId: 'loc-1',
      segment: {},
      body: 'Hi',
    });

    expect(vi.mocked(leadClient.get)).toHaveBeenCalledTimes(1);
  });

  it('does NOT terminate on a missing next_cursor snake_case field (regression: the old bug)', async () => {
    // If executeBulkSend were still reading next_cursor, only page 1 would be fetched.
    // With the fix, the loop uses nextCursor. We give it a snake_case field with a value
    // but nextCursor=null: the loop should treat nextCursor as the authoritative signal
    // and stop after page 1 (not page 0).
    vi.mocked(leadClient.get)
      .mockResolvedValueOnce({
        data: [makeLead('1')],
        nextCursor: 'has-more',
        next_cursor: null, // decoy; must be ignored
      } as never)
      .mockResolvedValueOnce({
        data: [makeLead('2')],
        nextCursor: null,
        next_cursor: 'should-be-ignored', // decoy; must be ignored
      } as never);

    vi.mocked(audienceClient.post).mockResolvedValue({ matched_entity_ids: ['1', '2'] });

    await executeBulkSend(mockDb, 'job-3', {
      locationId: 'loc-1',
      segment: {},
      body: 'Hi',
    });

    // Should fetch exactly 2 pages: nextCursor drove continuation and termination.
    expect(vi.mocked(leadClient.get)).toHaveBeenCalledTimes(2);
    // Both leads surfaced to audience evaluation.
    const entities = (vi.mocked(audienceClient.post).mock.calls[0][1] as {
      entities: Array<{ id: string }>;
    }).entities;
    expect(entities.map((e) => e.id).sort()).toEqual(['1', '2']);
  });
});
