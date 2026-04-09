import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/reward.repo.js', () => ({
  findById: vi.fn(),
  markIssued: vi.fn(),
}));

import { issueReward } from '../../src/services/reward.service.js';
import * as rewardRepo from '../../src/repositories/reward.repo.js';

const mockFindById = vi.mocked(rewardRepo.findById);
const mockMarkIssued = vi.mocked(rewardRepo.markIssued);

const fakeDb = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

function makePendingReward() {
  return {
    id: 'reward-1',
    referral_id: 'referral-1',
    referrer_id: 'referrer-1',
    status: 'pending',
    reward_type: null,
    reward_amount: null,
    reward_notes: null,
    issued_at: null,
    issued_by: null,
    created_at: new Date(),
  };
}

describe('issueReward', () => {
  it('throws 400 when reward already issued (status=issued)', async () => {
    mockFindById.mockResolvedValue({
      ...makePendingReward(),
      status: 'issued',
    });

    try {
      await issueReward(fakeDb, 'reward-1', {
        reward_type: 'gift_card',
        issuedBy: 'user-1',
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/already issued/i);
    }
  });

  it('throws 400 when reward_type is absent', async () => {
    mockFindById.mockResolvedValue(makePendingReward());

    try {
      await issueReward(fakeDb, 'reward-1', {
        reward_type: '',
        issuedBy: 'user-1',
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/reward_type/i);
    }
  });

  it('calls markIssued with correct params on success', async () => {
    const pending = makePendingReward();
    mockFindById.mockResolvedValue(pending);
    mockMarkIssued.mockResolvedValue({
      ...pending,
      status: 'issued',
      reward_type: 'gift_card',
      reward_amount: 50,
      issued_at: new Date(),
      issued_by: 'user-1',
    });

    const result = await issueReward(fakeDb, 'reward-1', {
      reward_type: 'gift_card',
      reward_amount: 50,
      reward_notes: 'Great referral',
      issuedBy: 'user-1',
    });

    expect(mockMarkIssued).toHaveBeenCalledWith(fakeDb, 'reward-1', {
      reward_type: 'gift_card',
      reward_amount: 50,
      reward_notes: 'Great referral',
      issued_by: 'user-1',
    });
    expect(result.status).toBe('issued');
  });

  it('throws 404 when reward not found', async () => {
    mockFindById.mockResolvedValue(null);

    try {
      await issueReward(fakeDb, 'nonexistent', {
        reward_type: 'gift_card',
        issuedBy: 'user-1',
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.statusCode).toBe(404);
    }
  });
});
