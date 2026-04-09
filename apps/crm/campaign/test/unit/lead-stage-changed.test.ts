import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/campaign-conversions.repo.js', () => ({
  insertConversion: vi.fn(),
}));

import { handleLeadStageChanged } from '../../src/handlers/lead-stage-changed.handler.js';
import type { LeadStageChangedPayload } from '../../src/handlers/lead-stage-changed.handler.js';
import * as conversionsRepo from '../../src/repositories/campaign-conversions.repo.js';

function makePayload(overrides: Partial<LeadStageChangedPayload> = {}): LeadStageChangedPayload {
  return {
    lead_id: 'lead-1',
    stage_to: 'exam_scheduled',
    pipeline: 'new_patient',
    occurred_at: '2026-04-08T12:00:00Z',
    ...overrides,
  };
}

// Mock Knex query builder — the handler calls:
// db('campaign_recipients').select(db.raw(...)).where({...}).whereNotNull('sent_at').where('sent_at', '>', db.raw(...))
// The last .where() must resolve the promise (be thenable).
function createMockDb(campaignIds: string[]) {
  const rows = campaignIds.map((id) => ({ campaign_id: id }));

  // Create a thenable chain object: every method returns the chain,
  // but the chain itself is also a thenable (has .then) so `await` resolves it.
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.whereNotNull = vi.fn().mockReturnValue(chain);
  chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => resolve(rows));

  const db = vi.fn().mockReturnValue(chain) as unknown as ReturnType<typeof vi.fn> & {
    raw: ReturnType<typeof vi.fn>;
  };
  db.raw = vi.fn().mockReturnValue('raw-sql-placeholder');

  return { db: db as never, chain, rows };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(conversionsRepo.insertConversion).mockResolvedValue(undefined);
});

describe('handleLeadStageChanged', () => {
  it('inserts conversion for campaigns within 7-day window', async () => {
    const { db } = createMockDb(['camp-1', 'camp-2']);
    const payload = makePayload();

    await handleLeadStageChanged(payload, db);

    expect(conversionsRepo.insertConversion).toHaveBeenCalledTimes(2);
    expect(conversionsRepo.insertConversion).toHaveBeenCalledWith(db, {
      campaign_id: 'camp-1',
      lead_id: 'lead-1',
      stage_to: 'exam_scheduled',
      pipeline: 'new_patient',
      converted_at: new Date('2026-04-08T12:00:00Z'),
    });
    expect(conversionsRepo.insertConversion).toHaveBeenCalledWith(db, {
      campaign_id: 'camp-2',
      lead_id: 'lead-1',
      stage_to: 'exam_scheduled',
      pipeline: 'new_patient',
      converted_at: new Date('2026-04-08T12:00:00Z'),
    });
  });

  it('does not insert conversion when no campaigns match (outside 7-day window)', async () => {
    const { db } = createMockDb([]);

    await handleLeadStageChanged(makePayload(), db);

    expect(conversionsRepo.insertConversion).not.toHaveBeenCalled();
  });

  it('does not insert conversion for holdout leads (sent_at=NULL filtered out by query)', async () => {
    // When sent_at is NULL, the whereNotNull('sent_at') filter excludes those rows
    // So the query returns empty results
    const { db } = createMockDb([]);

    await handleLeadStageChanged(makePayload(), db);

    expect(conversionsRepo.insertConversion).not.toHaveBeenCalled();
  });

  it('uses occurred_at as anchor for conversion timestamp (not now())', async () => {
    const { db } = createMockDb(['camp-1']);
    const payload = makePayload({ occurred_at: '2026-04-05T08:30:00Z' });

    await handleLeadStageChanged(payload, db);

    expect(conversionsRepo.insertConversion).toHaveBeenCalledWith(db, expect.objectContaining({
      converted_at: new Date('2026-04-05T08:30:00Z'),
    }));
  });

  it('handles unknown lead with no matching recipients gracefully', async () => {
    const { db } = createMockDb([]);

    await handleLeadStageChanged(makePayload({ lead_id: 'unknown-lead' }), db);

    expect(conversionsRepo.insertConversion).not.toHaveBeenCalled();
  });

  it('inserts conversion for single matching campaign', async () => {
    const { db } = createMockDb(['camp-99']);

    await handleLeadStageChanged(makePayload(), db);

    expect(conversionsRepo.insertConversion).toHaveBeenCalledTimes(1);
    expect(conversionsRepo.insertConversion).toHaveBeenCalledWith(db, expect.objectContaining({
      campaign_id: 'camp-99',
    }));
  });
});
