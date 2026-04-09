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
} from './helpers.js';

describe.skipIf(!HAS_DB)('Portal Token Routes (integration)', () => {
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

  it('token generated and portal_url returned', async () => {
    const referrer = await insertReferrer(db, {
      referrer_type: 'doctor',
      name: 'Dr. Token',
    });
    const jwt = makeJwt({ role: 'marketing_manager' });

    const res = await app.inject({
      method: 'POST',
      url: `/referrals/referrers/${referrer.id}/portal-token`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.token).toBeTruthy();
    expect(body.portal_url).toContain('/referrals/portal/');
    expect(body.portal_url).toContain(body.token);

    // Verify persisted in DB
    const dbRow = await db('portal_tokens')
      .where({ referrer_id: referrer.id })
      .first();
    expect(dbRow).toBeTruthy();
    expect(dbRow.token).toBe(body.token);
  });

  it('regeneration replaces previous token (UPSERT)', async () => {
    const referrer = await insertReferrer(db, { referrer_type: 'doctor' });
    const jwt = makeJwt({ role: 'marketing_manager' });

    // First creation
    const res1 = await app.inject({
      method: 'POST',
      url: `/referrals/referrers/${referrer.id}/portal-token`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    const body1 = JSON.parse(res1.body);

    // Second creation replaces
    const res2 = await app.inject({
      method: 'POST',
      url: `/referrals/referrers/${referrer.id}/portal-token`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    const body2 = JSON.parse(res2.body);

    expect(res2.statusCode).toBe(201);
    expect(body2.token).not.toBe(body1.token);

    // Only one row in DB
    const rows = await db('portal_tokens').where({
      referrer_id: referrer.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(body2.token);
  });

  it('400 if referrer_type is patient', async () => {
    const referrer = await insertReferrer(db, {
      referrer_type: 'patient',
      lead_id: 'patient-lead-1',
    });
    const jwt = makeJwt({ role: 'marketing_manager' });

    const res = await app.inject({
      method: 'POST',
      url: `/referrals/referrers/${referrer.id}/portal-token`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/patient/i);
  });
});
