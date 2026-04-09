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

const OTHER_LOCATION = '00000000-0000-0000-0000-000000000099';

describe.skipIf(!HAS_DB)('Leaderboard Routes (integration)', () => {
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

  it('ranked by cases_started DESC', async () => {
    const alice = await insertReferrer(db, { name: 'Alice', referrer_type: 'doctor' });
    const linkA = await insertReferralLink(db, { referrer_id: alice.id as string });
    const bob = await insertReferrer(db, { name: 'Bob', referrer_type: 'doctor' });
    const linkB = await insertReferralLink(db, { referrer_id: bob.id as string });

    // Alice: 2 converted
    await insertReferral(db, {
      referrer_id: alice.id as string,
      referral_link_id: linkA.id as string,
      lead_id: 'lead-lb-1',
      status: 'converted',
      converted_at: '2026-03-01T00:00:00Z',
    });
    await insertReferral(db, {
      referrer_id: alice.id as string,
      referral_link_id: linkA.id as string,
      lead_id: 'lead-lb-2',
      status: 'converted',
      converted_at: '2026-03-02T00:00:00Z',
    });

    // Bob: 1 converted
    await insertReferral(db, {
      referrer_id: bob.id as string,
      referral_link_id: linkB.id as string,
      lead_id: 'lead-lb-3',
      status: 'converted',
      converted_at: '2026-03-01T00:00:00Z',
    });

    const jwt = makeJwt();
    const res = await app.inject({
      method: 'GET',
      url: `/referrals/leaderboard?location_id=${LOCATION_ID}`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body[0].referrer_id).toBe(alice.id);
    expect(body[0].cases_started).toBe(2);
    expect(body[1].referrer_id).toBe(bob.id);
    expect(body[1].cases_started).toBe(1);
  });

  it('referrer_type filter applied', async () => {
    const doctor = await insertReferrer(db, { name: 'Dr. Doc', referrer_type: 'doctor' });
    const linkD = await insertReferralLink(db, { referrer_id: doctor.id as string });
    const patient = await insertReferrer(db, {
      name: 'Pat',
      referrer_type: 'patient',
      lead_id: 'pat-lead-1',
    });
    const linkP = await insertReferralLink(db, { referrer_id: patient.id as string });

    await insertReferral(db, {
      referrer_id: doctor.id as string,
      referral_link_id: linkD.id as string,
      lead_id: 'lead-lb-4',
    });
    await insertReferral(db, {
      referrer_id: patient.id as string,
      referral_link_id: linkP.id as string,
      lead_id: 'lead-lb-5',
    });

    const jwt = makeJwt();
    const res = await app.inject({
      method: 'GET',
      url: `/referrals/leaderboard?location_id=${LOCATION_ID}&referrer_type=doctor`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].referrer_type).toBe('doctor');
  });

  it('period_start/period_end uses correct date columns per metric', async () => {
    const referrer = await insertReferrer(db, { name: 'Period Tester' });
    const link = await insertReferralLink(db, { referrer_id: referrer.id as string });

    // Referral 1: exam in Feb, converted in March
    await insertReferral(db, {
      referrer_id: referrer.id as string,
      referral_link_id: link.id as string,
      lead_id: 'lead-lb-6',
      status: 'converted',
      exam_scheduled_at: '2026-02-15T00:00:00Z',
      converted_at: '2026-03-15T00:00:00Z',
    });

    // Referral 2: exam in Feb, not converted
    await insertReferral(db, {
      referrer_id: referrer.id as string,
      referral_link_id: link.id as string,
      lead_id: 'lead-lb-7',
      status: 'exam_scheduled',
      exam_scheduled_at: '2026-02-20T00:00:00Z',
    });

    const jwt = makeJwt();

    // Query with Feb period:
    // - total_referrals uses created_at (now, April) → 0 (outside Feb)
    // - exams_scheduled uses exam_scheduled_at → 2 (both in Feb)
    // - cases_started uses converted_at (March) → 0 (outside Feb)
    const res = await app.inject({
      method: 'GET',
      url: `/referrals/leaderboard?location_id=${LOCATION_ID}&period_start=2026-02-01&period_end=2026-02-28`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].total_referrals).toBe(0); // created_at is April, not in Feb
    expect(body[0].exams_scheduled).toBe(2); // both exam_scheduled_at in Feb
    expect(body[0].cases_started).toBe(0); // converted_at is March, not in Feb
  });

  it('location scoping excludes other locations', async () => {
    const local = await insertReferrer(db, { name: 'Local Ref' });
    const linkL = await insertReferralLink(db, { referrer_id: local.id as string });
    await insertReferral(db, {
      referrer_id: local.id as string,
      referral_link_id: linkL.id as string,
      lead_id: 'lead-lb-8',
    });

    const remote = await insertReferrer(db, {
      name: 'Remote Ref',
      location_id: OTHER_LOCATION,
    });
    const linkR = await insertReferralLink(db, { referrer_id: remote.id as string });
    await insertReferral(db, {
      referrer_id: remote.id as string,
      referral_link_id: linkR.id as string,
      lead_id: 'lead-lb-9',
      location_id: OTHER_LOCATION,
    });

    const jwt = makeJwt();
    const res = await app.inject({
      method: 'GET',
      url: `/referrals/leaderboard?location_id=${LOCATION_ID}`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Local Ref');
  });
});
