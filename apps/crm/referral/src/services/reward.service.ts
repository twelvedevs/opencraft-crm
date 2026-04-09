import type { Knex } from 'knex';
import * as rewardRepo from '../repositories/reward.repo.js';

interface IssueRewardBody {
  reward_type: string;
  reward_amount?: number | null;
  reward_notes?: string | null;
  issuedBy: string;
}

export async function issueReward(
  db: Knex,
  id: string,
  body: IssueRewardBody,
) {
  const reward = await rewardRepo.findById(db, id);
  if (!reward) {
    throw Object.assign(new Error('Reward not found'), { statusCode: 404 });
  }

  if (reward.status === 'issued') {
    throw Object.assign(new Error('Reward already issued'), { statusCode: 400 });
  }

  if (!body.reward_type) {
    throw Object.assign(new Error('reward_type is required'), { statusCode: 400 });
  }

  return rewardRepo.markIssued(db, id, {
    reward_type: body.reward_type,
    reward_amount: body.reward_amount,
    reward_notes: body.reward_notes,
    issued_by: body.issuedBy,
  });
}

export async function list(
  db: Knex,
  filters: {
    location_id: string;
    status?: string;
    referrer_id?: string;
    cursor?: string;
    limit?: number;
  },
) {
  return rewardRepo.listByStatus(db, filters);
}
