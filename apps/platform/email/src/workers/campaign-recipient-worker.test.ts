import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';
import type { Knex } from '../db.js';
import type { Redis } from 'ioredis';
import type { EmailCampaignRecipient } from '../repositories/email-campaign-recipients-repository.js';
import type { EmailCampaignJob } from '../repositories/email-campaign-jobs-repository.js';

vi.mock('bullmq', () => ({ Worker: vi.fn() }));
vi.mock('../repositories/email-campaign-recipients-repository.js', () => ({
  EmailCampaignRecipientsRepository: vi.fn(),
}));
vi.mock('../repositories/email-campaign-jobs-repository.js', () => ({
  EmailCampaignJobsRepository: vi.fn(),
}));
vi.mock('../repositories/domain-repository.js', () => ({ DomainRepository: vi.fn() }));
vi.mock('../clients/template-service-client.js', () => ({
  TemplateServiceClient: vi.fn(),
  TemplateRenderError: class TemplateRenderError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'TemplateRenderError';
    }
  },
  TemplateServiceUnavailableError: class TemplateServiceUnavailableError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'TemplateServiceUnavailableError';
    }
  },
}));
vi.mock('../env.js', () => ({
  env: { SENDGRID_API_KEY: 'test-key', TEMPLATE_SERVICE_URL: 'http://templates' },
}));

const makeRecipient = (overrides: Partial<EmailCampaignRecipient> = {}): EmailCampaignRecipient => ({
  id: 'rec-1',
  job_id: 'job-1',
  to_email: 'to@example.com',
  context: { name: 'Alice' },
  sendgrid_message_id: null,
  status: 'pending',
  attempt: 0,
  error: null,
  sent_at: null,
  delivered_at: null,
  opened_at: null,
  clicked_at: null,
  bounced_at: null,
  ...overrides,
});

const makeCampaignJob = (overrides: Partial<EmailCampaignJob> = {}): EmailCampaignJob => ({
  id: 'job-1',
  job_ref: 'ref-1',
  location_id: 'loc-1',
  entity_type: 'campaign',
  entity_id: 'camp-1',
  template_id: 'tmpl-1',
  subject_template: 'Hello {{name}}',
  domain_id: 'domain-1',
  scheduled_for: null,
  spam_score: null,
  spam_issues: null,
  status: 'processing',
  total_recipients: 1,
  sent_count: 0,
  failed_count: 0,
  created_by: null,
  created_at: new Date().toISOString(),
  started_at: null,
  completed_at: null,
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

describe('createCampaignRecipientWorker', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRecipientsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockJobsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDomainRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTemplateClient: any;
  let eventBus: EventBusImpl;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let publishSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let capturedProcessor: (job: any) => Promise<void>;

  beforeEach(async () => {
    const { Worker } = await import('bullmq');
    const { EmailCampaignRecipientsRepository } = await import(
      '../repositories/email-campaign-recipients-repository.js'
    );
    const { EmailCampaignJobsRepository } = await import(
      '../repositories/email-campaign-jobs-repository.js'
    );
    const { DomainRepository } = await import('../repositories/domain-repository.js');
    const { TemplateServiceClient } = await import('../clients/template-service-client.js');

    mockRecipientsRepo = {
      findById: vi.fn().mockResolvedValue(makeRecipient()),
      incrementAttempt: vi.fn().mockResolvedValue(undefined),
      markSent: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      markBounced: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(EmailCampaignRecipientsRepository).mockImplementation(() => mockRecipientsRepo);

    // Default: after increment, job has sent_count=1, failed_count=0, total_recipients=1 → completed
    mockJobsRepo = {
      findById: vi
        .fn()
        .mockResolvedValue(makeCampaignJob({ sent_count: 1, failed_count: 0, total_recipients: 1 })),
      incrementSentCount: vi.fn().mockResolvedValue(undefined),
      incrementFailedCount: vi.fn().mockResolvedValue(undefined),
      attemptCompletion: vi.fn().mockResolvedValue(true),
    };
    vi.mocked(EmailCampaignJobsRepository).mockImplementation(() => mockJobsRepo);

    mockDomainRepo = { findById: vi.fn().mockResolvedValue(makeDomain()) };
    vi.mocked(DomainRepository).mockImplementation(() => mockDomainRepo);

    mockTemplateClient = {
      render: vi.fn().mockResolvedValue({ html: '<p>Hello Alice</p>', text: 'Hello Alice' }),
    };
    vi.mocked(TemplateServiceClient).mockImplementation(() => mockTemplateClient);

    const driver = new MockDriver();
    eventBus = new EventBusImpl(driver);
    publishSpy = vi.spyOn(eventBus, 'publish').mockResolvedValue(undefined);

    vi.mocked(Worker).mockImplementation((_queue, proc) => {
      capturedProcessor = proc as typeof capturedProcessor;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instance: any = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn(),
      };
      return instance;
    });

    const { createCampaignRecipientWorker } = await import('./campaign-recipient-worker.js');
    createCampaignRecipientWorker({} as Redis, {} as Knex, eventBus);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('recipient status !== pending: returns early, no SendGrid call', async () => {
    mockRecipientsRepo.findById.mockResolvedValue(makeRecipient({ status: 'sent' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await capturedProcessor({ data: { recipientId: 'rec-1' } });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockRecipientsRepo.markSent).not.toHaveBeenCalled();
    expect(mockRecipientsRepo.incrementAttempt).not.toHaveBeenCalled();
  });

  it('recipient not found: returns early', async () => {
    mockRecipientsRepo.findById.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await capturedProcessor({ data: { recipientId: 'rec-1' } });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('template render 4xx: markFailed called, failed_count incremented, completion checked', async () => {
    const { TemplateRenderError } = await import('../clients/template-service-client.js');
    mockTemplateClient.render.mockRejectedValue(new TemplateRenderError('template render failed with status 422'));
    // After increment, job has failed_count=1 = total_recipients=1 → terminal 'failed'
    mockJobsRepo.findById.mockResolvedValue(
      makeCampaignJob({ sent_count: 0, failed_count: 1, total_recipients: 1 }),
    );

    await capturedProcessor({ data: { recipientId: 'rec-1' } });

    expect(mockRecipientsRepo.markFailed).toHaveBeenCalledWith('rec-1', expect.any(String));
    expect(mockJobsRepo.incrementFailedCount).toHaveBeenCalledWith('job-1');
    expect(mockJobsRepo.attemptCompletion).toHaveBeenCalledWith('job-1', 'failed');
  });

  it('template service 5xx: throws to trigger BullMQ retry', async () => {
    const { TemplateServiceUnavailableError } = await import('../clients/template-service-client.js');
    mockTemplateClient.render.mockRejectedValue(
      new TemplateServiceUnavailableError('service unavailable'),
    );

    await expect(capturedProcessor({ data: { recipientId: 'rec-1' } })).rejects.toThrow(
      'service unavailable',
    );
    expect(mockRecipientsRepo.markFailed).not.toHaveBeenCalled();
  });

  it('SendGrid 202: markSent called, sent_count incremented, email.campaign_completed published when last recipient', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 202,
        headers: new Headers({ 'X-Message-Id': 'sg-msg-1' }),
      }),
    );

    await capturedProcessor({ data: { recipientId: 'rec-1' } });

    expect(mockRecipientsRepo.markSent).toHaveBeenCalledWith('rec-1', 'sg-msg-1');
    expect(mockJobsRepo.incrementSentCount).toHaveBeenCalledWith('job-1');
    expect(mockJobsRepo.attemptCompletion).toHaveBeenCalledWith('job-1', 'completed');
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.campaign_completed',
        payload: expect.objectContaining({
          job_id: 'job-1',
          status: 'completed',
        }),
      }),
    );
  });

  it('SendGrid 400 (bounce): markBounced called, email.bounced published with to_address, failed_count incremented', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 400 }));
    mockJobsRepo.findById.mockResolvedValue(
      makeCampaignJob({ sent_count: 0, failed_count: 1, total_recipients: 1 }),
    );

    await capturedProcessor({ data: { recipientId: 'rec-1' } });

    expect(mockRecipientsRepo.markBounced).toHaveBeenCalledWith('rec-1');
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.bounced',
        payload: expect.objectContaining({ to_address: 'to@example.com' }),
      }),
    );
    expect(mockJobsRepo.incrementFailedCount).toHaveBeenCalledWith('job-1');
  });

  it('SendGrid 500: processor throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

    await expect(capturedProcessor({ data: { recipientId: 'rec-1' } })).rejects.toThrow(
      'SendGrid responded with 500',
    );
    expect(mockRecipientsRepo.markSent).not.toHaveBeenCalled();
    expect(mockRecipientsRepo.markBounced).not.toHaveBeenCalled();
  });

  it('completion with mixed sent/failed: status completed_with_errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 202, headers: new Headers({ 'X-Message-Id': 'sg-2' }) }),
    );
    // 2 total, 1 sent, 1 failed → completed_with_errors
    mockJobsRepo.findById.mockResolvedValue(
      makeCampaignJob({ sent_count: 1, failed_count: 1, total_recipients: 2 }),
    );

    await capturedProcessor({ data: { recipientId: 'rec-1' } });

    expect(mockJobsRepo.attemptCompletion).toHaveBeenCalledWith('job-1', 'completed_with_errors');
  });

  it('all failed: status failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 400 }));
    // 2 total, 0 sent, 2 failed → failed
    mockJobsRepo.findById.mockResolvedValue(
      makeCampaignJob({ sent_count: 0, failed_count: 2, total_recipients: 2 }),
    );

    await capturedProcessor({ data: { recipientId: 'rec-1' } });

    expect(mockJobsRepo.attemptCompletion).toHaveBeenCalledWith('job-1', 'failed');
  });
});
