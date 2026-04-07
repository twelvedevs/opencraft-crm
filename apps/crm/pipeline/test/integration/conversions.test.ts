import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  HAS_DB,
  runMigrations,
  cleanup,
  truncateTables,
  buildTestApp,
  mockDriver,
  LOCATION_ID,
  LEAD_ID_1,
} from './helpers.js';

const API_KEY = 'test-key';
const TRIGGERED_BY = '00000000-0000-0000-0000-000000000099';

describe.skipIf(!HAS_DB)('Conversion endpoints (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    mockDriver.published.length = 0;
  });

  /** Helper: enroll a lead and return the membership */
  async function enroll(
    opts: { pipeline?: string; stage?: string; lead_id?: string } = {},
  ) {
    const res = await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload: {
        lead_id: opts.lead_id ?? LEAD_ID_1,
        location_id: LOCATION_ID,
        pipeline: opts.pipeline ?? 'new_patient',
        stage: opts.stage ?? 'new_lead',
        reason: 'manual',
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  /** Helper: transition a membership */
  async function transition(id: string, stage: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/pipeline/memberships/${id}/transition`,
      headers: { 'x-internal-api-key': API_KEY },
      payload: {
        stage,
        override: true,
        triggered_by: TRIGGERED_BY,
        reason: 'manual',
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  /** Helper: convert a membership */
  async function convert(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/pipeline/memberships/${id}/convert`,
      headers: { 'x-internal-api-key': API_KEY },
      payload: body,
    });
  }

  // ── Valid conversion: new_patient/contract_signed → in_treatment/new_patient ──

  it('valid conversion: contract_signed → in_treatment/new_patient', async () => {
    const m = await enroll({ pipeline: 'new_patient', stage: 'new_lead' });
    await transition(m.id, 'contract_signed');
    mockDriver.published.length = 0;

    const res = await convert(m.id, {
      to_pipeline: 'in_treatment',
      to_stage: 'new_patient',
      triggered_by: TRIGGERED_BY,
      reason: 'converted',
      channel: 'website',
    });

    expect(res.statusCode).toBe(201);
    const newMembership = res.json();
    expect(newMembership.pipeline).toBe('in_treatment');
    expect(newMembership.stage).toBe('new_patient');

    // Source membership should be closed with reason 'converted'
    const sourceRes = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships/${m.id}`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    const source = sourceRes.json();
    expect(source.status).toBe('closed');
    expect(source.closed_reason).toBe('converted');

    // New membership created in in_treatment at new_patient
    expect(newMembership.id).not.toBe(m.id);
    expect(newMembership.status).toBe('active');

    // History: source has stage_from=contract_signed, stage_to=contract_signed, reason=converted
    const sourceHistRes = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships/${m.id}/history`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    const sourceHist = sourceHistRes.json();
    const conversionRow = sourceHist.find((h: Record<string, unknown>) => h.reason === 'converted');
    expect(conversionRow).toBeDefined();
    expect(conversionRow.stage_from).toBe('contract_signed');
    expect(conversionRow.stage_to).toBe('contract_signed');

    // History: target has stage_from=null, stage_to=new_patient, reason=converted
    const targetHistRes = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships/${newMembership.id}/history`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    const targetHist = targetHistRes.json();
    expect(targetHist).toHaveLength(1);
    expect(targetHist[0].stage_from).toBeNull();
    expect(targetHist[0].stage_to).toBe('new_patient');
    expect(targetHist[0].reason).toBe('converted');

    // Events: lead.converted + lead.stage_changed
    expect(mockDriver.published).toHaveLength(2);
    const convertedEvent = mockDriver.published.find(
      (e: Record<string, unknown>) => e.event_type === 'lead.converted',
    );
    expect(convertedEvent).toBeDefined();

    const stageChangedEvent = mockDriver.published.find(
      (e: Record<string, unknown>) => e.event_type === 'lead.stage_changed',
    );
    expect(stageChangedEvent).toBeDefined();
    const scPayload = stageChangedEvent!.payload as Record<string, unknown>;
    expect(scPayload.stage_from).toBeNull();
  });

  // ── Invalid source stage ──────────────────────────────────

  it('invalid source stage: new_lead cannot convert → 422', async () => {
    const m = await enroll({ pipeline: 'new_patient', stage: 'new_lead' });
    mockDriver.published.length = 0;

    const res = await convert(m.id, {
      to_pipeline: 'in_treatment',
      to_stage: 'new_patient',
      triggered_by: TRIGGERED_BY,
      reason: 'converted',
      channel: 'website',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('invalid_source_stage');
  });

  // ── Invalid conversion pair ───────────────────────────────

  it('invalid conversion pair: contract_signed → in_retention → 422', async () => {
    const m = await enroll({ pipeline: 'new_patient', stage: 'new_lead' });
    await transition(m.id, 'contract_signed');
    mockDriver.published.length = 0;

    const res = await convert(m.id, {
      to_pipeline: 'in_retention',
      to_stage: 'active_retention',
      triggered_by: TRIGGERED_BY,
      reason: 'converted',
      channel: 'website',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('invalid_conversion');
  });

  // ── Double convert ────────────────────────────────────────

  it('double convert: second attempt → 409', async () => {
    const m = await enroll({ pipeline: 'new_patient', stage: 'new_lead' });
    await transition(m.id, 'contract_signed');
    mockDriver.published.length = 0;

    // First convert succeeds
    const first = await convert(m.id, {
      to_pipeline: 'in_treatment',
      to_stage: 'new_patient',
      triggered_by: TRIGGERED_BY,
      reason: 'converted',
      channel: 'website',
    });
    expect(first.statusCode).toBe(201);

    // Second convert fails (source membership is now closed)
    const second = await convert(m.id, {
      to_pipeline: 'in_treatment',
      to_stage: 'new_patient',
      triggered_by: TRIGGERED_BY,
      reason: 'converted',
      channel: 'website',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('membership_not_active');
  });
});
