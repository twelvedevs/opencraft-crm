import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  checkInfra,
  createTestContext,
  resetSchema,
  truncateTables,
  type TestContext,
} from './helpers.js';

const infraAvailable = await checkInfra();

describe.skipIf(!infraAvailable)('Send flow integration', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await resetSchema(ctx.db);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateTables(ctx.db);
    ctx.twilioStub.calls.length = 0;
    ctx.twilioStub.setError(undefined);
    ctx.mockDriver.published.length = 0;
    // Flush rate limiter keys
    const keys = await ctx.redis.keys('rate_limit:msg:*');
    if (keys.length > 0) await ctx.redis.del(...keys);
  });

  it('(a) happy path — resolves number, renders template, sends via Twilio', async () => {
    // Seed a number
    await ctx.db('messaging_numbers').insert({
      location_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      channel: 'sms_inbox',
      phone_number: '+15550001001',
      rate_limit_mps: 10,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/messages/send',
      payload: {
        to: '+15551234567',
        location_id: 'aaaaaaaa-0000-0000-0000-000000000001',
        channel: 'sms_inbox',
        template: 'Hello {{name}}, your appointment is {{day}}.',
        context: { name: 'Sara', day: 'Monday' },
        dedup_key: 'test-dedup-1',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('queued');
    expect(body.message_id).toBeDefined();

    // Twilio stub called once
    expect(ctx.twilioStub.calls).toHaveLength(1);
    expect(ctx.twilioStub.calls[0].to).toBe('+15551234567');
    expect(ctx.twilioStub.calls[0].from).toBe('+15550001001');
    expect(ctx.twilioStub.calls[0].body).toBe('Hello Sara, your appointment is Monday.');

    // Message inserted in DB
    const msg = await ctx.db('messaging_messages').where({ id: body.message_id }).first();
    expect(msg.status).toBe('queued');
    expect(msg.twilio_sid).toMatch(/^SM/);
  });

  it('(b) dedup — same dedup_key twice, Twilio called once', async () => {
    await ctx.db('messaging_numbers').insert({
      location_id: 'aaaaaaaa-0000-0000-0000-000000000002',
      channel: 'sms_inbox',
      phone_number: '+15550001002',
      rate_limit_mps: 10,
    });

    const payload = {
      to: '+15551234567',
      location_id: 'aaaaaaaa-0000-0000-0000-000000000002',
      channel: 'sms_inbox',
      body: 'Test message',
      dedup_key: 'dedup-same-key',
    };

    const res1 = await ctx.app.inject({ method: 'POST', url: '/messages/send', payload });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().status).toBe('queued');
    const messageId = res1.json().message_id;

    const res2 = await ctx.app.inject({ method: 'POST', url: '/messages/send', payload });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().status).toBe('duplicate');
    expect(res2.json().message_id).toBe(messageId);

    // Twilio called exactly once
    expect(ctx.twilioStub.calls).toHaveLength(1);
  });

  it('(c) opted-out number returns 400, Twilio never called', async () => {
    // Seed opt-out
    await ctx.db('messaging_opt_outs').insert({
      phone_number: '+15559999999',
      source: 'stop_reply',
    });

    await ctx.db('messaging_numbers').insert({
      location_id: 'aaaaaaaa-0000-0000-0000-000000000003',
      channel: 'sms_inbox',
      phone_number: '+15550001003',
      rate_limit_mps: 10,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/messages/send',
      payload: {
        to: '+15559999999',
        location_id: 'aaaaaaaa-0000-0000-0000-000000000003',
        channel: 'sms_inbox',
        body: 'Test',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('opted_out');
    expect(ctx.twilioStub.calls).toHaveLength(0);
  });

  it('(d) rate limit exceeded returns 429 with Retry-After', async () => {
    await ctx.db('messaging_numbers').insert({
      location_id: 'aaaaaaaa-0000-0000-0000-000000000004',
      channel: 'sms_inbox',
      phone_number: '+15550001004',
      rate_limit_mps: 1, // 1 message per second
    });

    const payload = {
      to: '+15551234567',
      location_id: 'aaaaaaaa-0000-0000-0000-000000000004',
      channel: 'sms_inbox',
      body: 'Test',
    };

    // First should succeed
    const res1 = await ctx.app.inject({ method: 'POST', url: '/messages/send', payload });
    expect(res1.statusCode).toBe(200);

    // Second should be throttled
    const res2 = await ctx.app.inject({ method: 'POST', url: '/messages/send', payload: { ...payload, dedup_key: 'no-dup' } });
    expect(res2.statusCode).toBe(429);
    expect(res2.json().error).toBe('throttled');
    expect(res2.headers['retry-after']).toBeDefined();
  });

  it('(e) number resolve failure returns 422', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/messages/send',
      payload: {
        to: '+15551234567',
        location_id: 'aaaaaaaa-0000-0000-0000-nonexistent1',
        channel: 'sms_inbox',
        body: 'Test',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('No active number');
  });

  it('(f) Twilio error — message inserted with status failed, returns 502', async () => {
    await ctx.db('messaging_numbers').insert({
      location_id: 'aaaaaaaa-0000-0000-0000-000000000005',
      channel: 'sms_inbox',
      phone_number: '+15550001005',
      rate_limit_mps: 10,
    });

    ctx.twilioStub.setError(new Error('Twilio is down'));

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/messages/send',
      payload: {
        to: '+15551234567',
        location_id: 'aaaaaaaa-0000-0000-0000-000000000005',
        channel: 'sms_inbox',
        body: 'Test',
      },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('Twilio is down');

    // Message inserted with failed status
    const msgs = await ctx.db('messaging_messages').where({ status: 'failed' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].error_code).toBe('TWILIO_SEND_ERROR');
  });
});
