import { describe, it, expect, vi } from 'vitest';
import type { Knex } from 'knex';
import type { CampaignRecipient } from '../../src/repositories/campaign-recipients.repo.js';
import { findAllHoldoutByCampaign } from '../../src/repositories/campaign-recipients.repo.js';

function makeRecipient(leadId: string): CampaignRecipient {
  return {
    campaign_id: 'camp-1',
    lead_id: leadId,
    email: `${leadId}@test.com`,
    location_id: 'loc-1',
    variant: 'holdout',
    sent_at: null,
  };
}

/** Build a mock Knex where each call to db(TABLE) resolves to the next configured page. */
function makePagedDb(pages: CampaignRecipient[][]): { db: Knex; callCount: () => number } {
  let call = 0;
  const dbFn = vi.fn().mockImplementation(() => {
    const page = pages[call++] ?? [];
    const q: Record<string, unknown> = {
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      then(onFulfilled: (v: CampaignRecipient[]) => unknown, onRejected: (e: unknown) => unknown) {
        return Promise.resolve(page).then(onFulfilled, onRejected);
      },
      catch(onRejected: (e: unknown) => unknown) {
        return Promise.resolve(page).catch(onRejected);
      },
      finally(onFinally: () => void) {
        return Promise.resolve(page).finally(onFinally);
      },
    };
    return q;
  });
  return { db: dbFn as unknown as Knex, callCount: () => call };
}

describe('findAllHoldoutByCampaign', () => {
  it('returns all rows when a single page has fewer than 1000 rows', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRecipient(`lead-${i}`));
    const { db } = makePagedDb([rows]);

    const result = await findAllHoldoutByCampaign(db, 'camp-1');

    expect(result).toHaveLength(3);
  });

  it('fetches a second page when the first page is exactly 1000 rows', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeRecipient(`lead-${i}`));
    const page2 = [makeRecipient('lead-1000'), makeRecipient('lead-1001')];
    const { db, callCount } = makePagedDb([page1, page2]);

    const result = await findAllHoldoutByCampaign(db, 'camp-1');

    expect(result).toHaveLength(1002);
    expect(callCount()).toBe(2);
  });

  it('stops after an empty page (no rows on second call)', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeRecipient(`lead-${i}`));
    const page2: CampaignRecipient[] = [];
    const { db, callCount } = makePagedDb([page1, page2]);

    const result = await findAllHoldoutByCampaign(db, 'camp-1');

    expect(result).toHaveLength(1000);
    expect(callCount()).toBe(2);
  });

  it('handles three pages correctly', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeRecipient(`lead-p1-${i}`));
    const page2 = Array.from({ length: 1000 }, (_, i) => makeRecipient(`lead-p2-${i}`));
    const page3 = [makeRecipient('lead-p3-0')];
    const { db, callCount } = makePagedDb([page1, page2, page3]);

    const result = await findAllHoldoutByCampaign(db, 'camp-1');

    expect(result).toHaveLength(2001);
    expect(callCount()).toBe(3);
  });
});
