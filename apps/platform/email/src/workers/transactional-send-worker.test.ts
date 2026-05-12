import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';
import type { Knex } from '../db.js';
import type { Redis } from 'ioredis';
import type { EmailSend } from '../repositories/email-sends-repository.js';

vi.mock('bullmq', () => ({ Worker: vi.fn() }));
vi.mock('../repositories/email-sends-repository.js', () => ({ EmailSendsRepository: vi.fn() }));
vi.mock('../repositories/domain-repository.js', () => ({ DomainRepository: vi.fn() }));
vi.mock('../env.js', () => ({ env: { SENDGRID_API_KEY: 'test-key' } }));

const makeSend = (overrides: Partial<EmailSend> = {}): EmailSend => ({
  id: 'send-1',
  dedup_key: 'dedup-1',
  location_id: 'loc-1',
  domain_id: 'domain-1',
  entity_type: null,
  entity_id: null,
  to_email: 'to@example.com',
  subject: 'Test',
  sendgrid_message_id: null,
  status: 'queued',
  attempt: 0,
  error: null,
  created_at: new Date().toISOString(),
  sent_at: null,
  delivered_at: null,
  opened_at: null,
  clicked_at: null,
  bounced_at: null,
  ...overrides,
});

const makeDomain = () => ({
  id: 'domain-1',
  from_email: 'from@mail.example.com',
  from_name: 'Example',
  location_id: 'loc-1',
  domain: 'mail.example.com',
  is_verified: true,
  spam_score_threshold: 5,
  sendgrid_domain_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const jobData = {
  emailSendId: 'send-1',
  to: 'to@example.com',
  subject: 'Test',
  html: '<p>Hello</p>',
  text: 'Hello',
};

describe('createTransactionalSendWorker', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDomainRepo: any;
  let eventBus: EventBusImpl;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let publishSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let capturedProcessor: (job: any) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let capturedFailedHandler: (job: any, err: Error) => Promise<void>;

  beforeEach(async () => {
    const { Worker } = await import('bullmq');
    const { EmailSendsRepository } = await import('../repositories/email-sends-repository.js');
    const { DomainRepository } = await import('../repositories/domain-repository.js');

    mockRepo = {
      findById: vi.fn().mockResolvedValue(makeSend()),
      incrementAttempt: vi.fn().mockResolvedValue(undefined),
      markSent: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(EmailSendsRepository).mockImplementation(() => mockRepo);

    mockDomainRepo = { findById: vi.fn().mockResolvedValue(makeDomain()) };
    vi.mocked(DomainRepository).mockImplementation(() => mockDomainRepo);

    const driver = new MockDriver();
    eventBus = new EventBusImpl(driver);
    publishSpy = vi.spyOn(eventBus, 'publish').mockResolvedValue(undefined);

    // Capture processor and failed handler when Worker is constructed
    vi.mocked(Worker).mockImplementation((_queue, proc) => {
      capturedProcessor = proc as typeof capturedProcessor;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instance: any = {
        on: vi.fn((event: string, handler: typeof capturedFailedHandler) => {
          if (event === 'failed') capturedFailedHandler = handler;
          return instance;
        }),
        close: vi.fn(),
      };
      return instance;
    });

    const { createTransactionalSendWorker } = await import('./transactional-send-worker.js');
    createTransactionalSendWorker({} as Redis, {} as Knex, eventBus);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('crash recovery guard: returns without calling fetch when sendgrid_message_id is set', async () => {
    mockRepo.findById.mockResolvedValue(makeSend({ sendgrid_message_id: 'already-sent' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await capturedProcessor({ data: jobData });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockRepo.markSent).not.toHaveBeenCalled();
  });

  it('SendGrid 202: calls markSent with X-Message-Id and publishes email.sent', async () => {
    const mockHeaders = new Headers({ 'X-Message-Id': 'sg-msg-123' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 202, headers: mockHeaders }),
    );

    await capturedProcessor({ data: jobData });

    expect(mockRepo.markSent).toHaveBeenCalledWith('send-1', 'sg-msg-123');
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.sent',
        payload: expect.objectContaining({
          email_id: 'send-1',
          sendgrid_message_id: 'sg-msg-123',
        }),
      }),
    );
  });

  it('SendGrid 500: processor throws to trigger BullMQ retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

    await expect(capturedProcessor({ data: jobData })).rejects.toThrow(
      'SendGrid responded with 500',
    );
    expect(mockRepo.markSent).not.toHaveBeenCalled();
  });

  it('failed handler with attemptsMade >= attempts: calls markFailed and publishes email.failed', async () => {
    const job = { data: jobData, attemptsMade: 5, opts: { attempts: 5 } };
    const err = new Error('SendGrid responded with 500');

    await capturedFailedHandler(job, err);

    expect(mockRepo.markFailed).toHaveBeenCalledWith('send-1', err.message);
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.failed',
        payload: expect.objectContaining({
          email_id: 'send-1',
          error: err.message,
        }),
      }),
    );
  });

  it('failed handler with attemptsMade < attempts: does not call markFailed', async () => {
    const job = { data: jobData, attemptsMade: 2, opts: { attempts: 5 } };
    const err = new Error('SendGrid responded with 500');

    await capturedFailedHandler(job, err);

    expect(mockRepo.markFailed).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
