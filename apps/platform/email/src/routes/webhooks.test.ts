import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';
import type { Knex } from '../db.js';
import type { Queue } from 'bullmq';

vi.mock('../services/sendgrid-signature-verifier.js', () => ({
  SendgridSignatureVerifier: vi.fn(),
}));

vi.mock('../services/webhook-processor.js', () => ({
  WebhookProcessor: vi.fn(),
}));

function makeKnexStub(): Knex {
  return {} as unknown as Knex;
}

function makeQueueStub() {
  return {
    transactionalSend: { close: vi.fn(), add: vi.fn() } as unknown as Queue,
    campaignRecipient: { close: vi.fn(), add: vi.fn() } as unknown as Queue,
  };
}

function makeEvents(count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    event: 'delivered',
    sg_message_id: `msg-${i}`,
    email: `user${i}@example.com`,
    timestamp: 1711700000,
  }));
}

describe('POST /webhooks/sendgrid', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockVerifierInstance: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockProcessorInstance: any;
  let queues: ReturnType<typeof makeQueueStub>;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  beforeEach(async () => {
    const { SendgridSignatureVerifier } = await import('../services/sendgrid-signature-verifier.js');
    const { WebhookProcessor } = await import('../services/webhook-processor.js');

    mockVerifierInstance = {
      verify: vi.fn().mockResolvedValue(true),
    };
    vi.mocked(SendgridSignatureVerifier).mockImplementation(() => mockVerifierInstance);

    mockProcessorInstance = {
      processBatch: vi.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(WebhookProcessor).mockImplementation(() => mockProcessorInstance as any);

    queues = makeQueueStub();
    const driver = new MockDriver();
    const eventBus = new EventBusImpl(driver);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    app = await buildApp(makeKnexStub(), eventBus, queues);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('(a) valid signature → 200 with received count', async () => {
    const events = makeEvents(2);

    const response = await app!.inject({
      method: 'POST',
      url: '/webhooks/sendgrid',
      headers: {
        'x-twilio-email-event-webhook-signature': 'valid-sig',
        'x-twilio-email-event-webhook-timestamp': '1711700000',
      },
      payload: events,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: 2 });
  });

  it('(b) invalid signature (verifier returns false) → 403', async () => {
    mockVerifierInstance.verify.mockResolvedValue(false);

    const response = await app!.inject({
      method: 'POST',
      url: '/webhooks/sendgrid',
      headers: {
        'x-twilio-email-event-webhook-signature': 'bad-sig',
        'x-twilio-email-event-webhook-timestamp': '1711700000',
      },
      payload: makeEvents(1),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'invalid_signature' });
  });

  it('(c) missing signature headers → verifier receives empty strings → 403', async () => {
    mockVerifierInstance.verify.mockResolvedValue(false);

    const response = await app!.inject({
      method: 'POST',
      url: '/webhooks/sendgrid',
      payload: makeEvents(1),
    });

    expect(response.statusCode).toBe(403);
    expect(mockVerifierInstance.verify).toHaveBeenCalledWith(
      expect.objectContaining({ signature: '', timestamp: '' }),
    );
  });

  it('(d) valid signature with 3-event batch → processBatch called once with array of 3', async () => {
    const events = makeEvents(3);

    const response = await app!.inject({
      method: 'POST',
      url: '/webhooks/sendgrid',
      headers: {
        'x-twilio-email-event-webhook-signature': 'valid-sig',
        'x-twilio-email-event-webhook-timestamp': '1711700000',
      },
      payload: events,
    });

    expect(response.statusCode).toBe(200);
    expect(mockProcessorInstance.processBatch).toHaveBeenCalledOnce();
    const callArg = mockProcessorInstance.processBatch.mock.calls[0][0];
    expect(callArg).toHaveLength(3);
  });

  it('(e) verifier throws unexpectedly → handler returns 500', async () => {
    mockVerifierInstance.verify.mockRejectedValue(new Error('SecretsManager outage'));

    const response = await app!.inject({
      method: 'POST',
      url: '/webhooks/sendgrid',
      headers: {
        'x-twilio-email-event-webhook-signature': 'sig',
        'x-twilio-email-event-webhook-timestamp': '1711700000',
      },
      payload: makeEvents(1),
    });

    expect(response.statusCode).toBe(500);
  });
});
