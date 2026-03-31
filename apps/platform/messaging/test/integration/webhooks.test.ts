import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  checkInfra,
  createTestContext,
  resetSchema,
  truncateTables,
  generateTwilioSignature,
  TEST_AUTH_TOKEN,
  type TestContext,
} from './helpers.js';

const infraAvailable = await checkInfra();

describe.skipIf(!infraAvailable)('Webhook integration', () => {
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
    ctx.mockDriver.published.length = 0;
  });

  function webhookUrl(path: string): string {
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return `http://localhost:${port}${path}`;
  }

  function injectStatusCallback(params: Record<string, string>) {
    const url = webhookUrl('/webhooks/twilio/status');
    const signature = generateTwilioSignature(TEST_AUTH_TOKEN, url, params);
    return ctx.app.inject({
      method: 'POST',
      url: '/webhooks/twilio/status',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      payload: new URLSearchParams(params).toString(),
    });
  }

  function injectInbound(params: Record<string, string>) {
    const url = webhookUrl('/webhooks/twilio/inbound');
    const signature = generateTwilioSignature(TEST_AUTH_TOKEN, url, params);
    return ctx.app.inject({
      method: 'POST',
      url: '/webhooks/twilio/inbound',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      payload: new URLSearchParams(params).toString(),
    });
  }

  // --- Status callback tests ---

  it('(a) status callback delivered — DB updated + message.delivered event published', async () => {
    // Seed a number for location_id resolution
    await ctx.db('messaging_numbers').insert({
      location_id: 'bbbbbbbb-0000-0000-0000-000000000001',
      channel: 'sms_inbox',
      phone_number: '+15550001001',
      rate_limit_mps: 3,
    });

    // Seed a message
    const [msg] = await ctx.db('messaging_messages')
      .insert({
        direction: 'outbound',
        to_number: '+15551234567',
        from_number: '+15550001001',
        body: 'Test',
        status: 'sent',
        twilio_sid: 'SM_delivered_test',
      })
      .returning('*');

    const res = await injectStatusCallback({
      MessageSid: 'SM_delivered_test',
      MessageStatus: 'delivered',
    });

    expect(res.statusCode).toBe(200);

    // DB updated
    const updated = await ctx.db('messaging_messages').where({ id: msg.id }).first();
    expect(updated.status).toBe('delivered');
    expect(updated.delivered_at).not.toBeNull();

    // Event published
    const deliveredEvents = ctx.mockDriver.published.filter(
      (e) => e.event_type === 'message.delivered',
    );
    expect(deliveredEvents).toHaveLength(1);
    expect(deliveredEvents[0].payload).toMatchObject({
      message_id: msg.id,
      twilio_sid: 'SM_delivered_test',
      location_id: 'bbbbbbbb-0000-0000-0000-000000000001',
    });
  });

  it('(b) status callback failed — DB updated + message.failed event published', async () => {
    await ctx.db('messaging_numbers').insert({
      location_id: 'bbbbbbbb-0000-0000-0000-000000000002',
      channel: 'sms_inbox',
      phone_number: '+15550001002',
      rate_limit_mps: 3,
    });

    const [msg] = await ctx.db('messaging_messages')
      .insert({
        direction: 'outbound',
        to_number: '+15551234567',
        from_number: '+15550001002',
        body: 'Test',
        status: 'sent',
        twilio_sid: 'SM_failed_test',
      })
      .returning('*');

    const res = await injectStatusCallback({
      MessageSid: 'SM_failed_test',
      MessageStatus: 'failed',
      ErrorCode: '30006',
      ErrorMessage: 'Landline or unreachable carrier',
    });

    expect(res.statusCode).toBe(200);

    const updated = await ctx.db('messaging_messages').where({ id: msg.id }).first();
    expect(updated.status).toBe('failed');
    expect(updated.error_code).toBe('30006');
    expect(updated.error_message).toBe('Landline or unreachable carrier');

    const failedEvents = ctx.mockDriver.published.filter(
      (e) => e.event_type === 'message.failed',
    );
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].payload).toMatchObject({
      message_id: msg.id,
      error_code: '30006',
      error_message: 'Landline or unreachable carrier',
      location_id: 'bbbbbbbb-0000-0000-0000-000000000002',
    });
  });

  it('(c) invalid Twilio signature — 403, no DB writes, no events', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/twilio/status',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'invalid-signature',
      },
      payload: new URLSearchParams({
        MessageSid: 'SM_invalid_sig',
        MessageStatus: 'delivered',
      }).toString(),
    });

    expect(res.statusCode).toBe(403);
    expect(ctx.mockDriver.published).toHaveLength(0);

    const msgs = await ctx.db('messaging_messages').where({ twilio_sid: 'SM_invalid_sig' });
    expect(msgs).toHaveLength(0);
  });

  // --- Inbound message tests ---

  it('(d) inbound STOP — message inserted, opt-out created, opt_out.received + inbound_message.received published', async () => {
    // Seed the 'To' number for location_id resolution
    await ctx.db('messaging_numbers').insert({
      location_id: 'bbbbbbbb-0000-0000-0000-000000000003',
      channel: 'sms_inbox',
      phone_number: '+15550001003',
      rate_limit_mps: 3,
    });

    const res = await injectInbound({
      From: '+15559998888',
      To: '+15550001003',
      Body: 'STOP',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');

    // Message inserted
    const msgs = await ctx.db('messaging_messages').where({ from_number: '+15559998888' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe('inbound');
    expect(msgs[0].message_type).toBe('stop');
    expect(msgs[0].status).toBe('received');

    // Opt-out created
    const optOut = await ctx.db('messaging_opt_outs').where({ phone_number: '+15559998888' }).first();
    expect(optOut).toBeDefined();
    expect(optOut.source).toBe('stop_reply');

    // Events published
    const inboundEvents = ctx.mockDriver.published.filter(
      (e) => e.event_type === 'inbound_message.received',
    );
    expect(inboundEvents).toHaveLength(1);
    expect(inboundEvents[0].payload).toMatchObject({
      from_number: '+15559998888',
      to_number: '+15550001003',
      message_type: 'stop',
    });

    const optOutEvents = ctx.mockDriver.published.filter(
      (e) => e.event_type === 'opt_out.received',
    );
    expect(optOutEvents).toHaveLength(1);
    expect(optOutEvents[0].payload).toMatchObject({
      phone_number: '+15559998888',
      source: 'stop_reply',
      location_id: 'bbbbbbbb-0000-0000-0000-000000000003',
    });
  });

  it('(e) inbound UNSTOP (was opted out) — message inserted, opt-out removed, opt_out.removed + inbound_message.received published', async () => {
    await ctx.db('messaging_numbers').insert({
      location_id: 'bbbbbbbb-0000-0000-0000-000000000004',
      channel: 'sms_inbox',
      phone_number: '+15550001004',
      rate_limit_mps: 3,
    });

    // Pre-seed opt-out
    await ctx.db('messaging_opt_outs').insert({
      phone_number: '+15557776666',
      source: 'stop_reply',
    });

    const res = await injectInbound({
      From: '+15557776666',
      To: '+15550001004',
      Body: 'START',
    });

    expect(res.statusCode).toBe(200);

    // Message inserted
    const msgs = await ctx.db('messaging_messages').where({ from_number: '+15557776666' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message_type).toBe('unstop');

    // Opt-out removed
    const optOut = await ctx.db('messaging_opt_outs').where({ phone_number: '+15557776666' }).first();
    expect(optOut).toBeUndefined();

    // Events
    const inboundEvents = ctx.mockDriver.published.filter(
      (e) => e.event_type === 'inbound_message.received',
    );
    expect(inboundEvents).toHaveLength(1);

    const removedEvents = ctx.mockDriver.published.filter(
      (e) => e.event_type === 'opt_out.removed',
    );
    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0].payload).toMatchObject({
      phone_number: '+15557776666',
    });
  });

  it('(f) inbound UNSTOP (was NOT opted out) — message inserted, no opt_out.removed event, inbound_message.received published', async () => {
    await ctx.db('messaging_numbers').insert({
      location_id: 'bbbbbbbb-0000-0000-0000-000000000005',
      channel: 'sms_inbox',
      phone_number: '+15550001005',
      rate_limit_mps: 3,
    });

    const res = await injectInbound({
      From: '+15553332222',
      To: '+15550001005',
      Body: 'UNSTOP',
    });

    expect(res.statusCode).toBe(200);

    // Message inserted
    const msgs = await ctx.db('messaging_messages').where({ from_number: '+15553332222' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message_type).toBe('unstop');

    // No opt_out.removed event
    const removedEvents = ctx.mockDriver.published.filter(
      (e) => e.event_type === 'opt_out.removed',
    );
    expect(removedEvents).toHaveLength(0);

    // inbound_message.received published
    const inboundEvents = ctx.mockDriver.published.filter(
      (e) => e.event_type === 'inbound_message.received',
    );
    expect(inboundEvents).toHaveLength(1);
  });

  it('(g) inbound normal — message inserted, inbound_message.received published with message_type normal', async () => {
    await ctx.db('messaging_numbers').insert({
      location_id: 'bbbbbbbb-0000-0000-0000-000000000006',
      channel: 'sms_inbox',
      phone_number: '+15550001006',
      rate_limit_mps: 3,
    });

    const res = await injectInbound({
      From: '+15551112222',
      To: '+15550001006',
      Body: 'Hello, I have a question about my appointment.',
    });

    expect(res.statusCode).toBe(200);

    const msgs = await ctx.db('messaging_messages').where({ from_number: '+15551112222' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message_type).toBe('normal');

    const inboundEvents = ctx.mockDriver.published.filter(
      (e) => e.event_type === 'inbound_message.received',
    );
    expect(inboundEvents).toHaveLength(1);
    expect(inboundEvents[0].payload).toMatchObject({
      message_type: 'normal',
      from_number: '+15551112222',
    });

    // No opt-out events
    const optOutEvents = ctx.mockDriver.published.filter(
      (e) => e.event_type === 'opt_out.received' || e.event_type === 'opt_out.removed',
    );
    expect(optOutEvents).toHaveLength(0);
  });

  it('(h) status callback intermediate (sent) — DB updated, no EventBridge event', async () => {
    const [msg] = await ctx.db('messaging_messages')
      .insert({
        direction: 'outbound',
        to_number: '+15551234567',
        from_number: '+15550009999',
        body: 'Test',
        status: 'queued',
        twilio_sid: 'SM_sent_test',
      })
      .returning('*');

    const res = await injectStatusCallback({
      MessageSid: 'SM_sent_test',
      MessageStatus: 'sent',
    });

    expect(res.statusCode).toBe(200);

    // DB updated
    const updated = await ctx.db('messaging_messages').where({ id: msg.id }).first();
    expect(updated.status).toBe('sent');

    // No events published
    expect(ctx.mockDriver.published).toHaveLength(0);
  });
});
