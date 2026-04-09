import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import {
  HAS_DB,
  runMigrations,
  cleanup,
  truncateTables,
  getDb,
  buildTestApp,
  makeJwt,
  insertReferrer,
  insertReferralLink,
  insertReferral,
  LOCATION_ID,
} from './helpers.js';

describe.skipIf(!HAS_DB)('Rewards Routes (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;

  beforeAll(async () => {
    db = getDb();
    await runMigrations();
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  async function setupRewardData() {
    const referrer = await insertReferrer(db);
    const link = await insertReferralLink(db, {
      referrer_id: referrer.id as string,
    });
    const referral = await insertReferral(db, {
      referrer_id: referrer.id as string,
      referral_link_id: link.id as string,
      lead_id: 'lead-reward-1',
      status: 'converted',
    });
    const [reward] = await db('reward_events')
      .insert({
        referral_id: referral.id,
        referrer_id: referrer.id,
      })
      .returning('*');
    return { referrer, link, referral, reward };
  }

  it('PATCH pending→issued: reward_type, issued_at, issued_by set correctly', async () => {
    const { reward } = await setupRewardData();
    const jwt = makeJwt({ sub: 'staff-user-1', role: 'marketing_manager' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/referrals/rewards/${reward.id}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        status: 'issued',
        reward_type: 'gift_card',
        reward_amount: 50,
        reward_notes: 'Thank you!',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('issued');
    expect(body.reward_type).toBe('gift_card');
    expect(body.reward_amount).toBe(50);
    expect(body.reward_notes).toBe('Thank you!');
    expect(body.issued_by).toBe('staff-user-1');
    expect(body.issued_at).toBeTruthy();
  });

  it('400 on double-issue', async () => {
    const { reward } = await setupRewardData();
    const jwt = makeJwt({ role: 'marketing_manager' });

    // First issue succeeds
    await app.inject({
      method: 'PATCH',
      url: `/referrals/rewards/${reward.id}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { status: 'issued', reward_type: 'gift_card' },
    });

    // Second issue fails
    const res = await app.inject({
      method: 'PATCH',
      url: `/referrals/rewards/${reward.id}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { status: 'issued', reward_type: 'gift_card' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/already issued/i);
  });

  it('400 when reward_type absent', async () => {
    const { reward } = await setupRewardData();
    const jwt = makeJwt({ role: 'marketing_manager' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/referrals/rewards/${reward.id}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { status: 'issued' },
    });

    expect(res.statusCode).toBe(400);
  });
});
