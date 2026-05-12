import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';
import type { Knex } from '../db.js';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { DomainNotConfiguredError, DomainNotVerifiedError } from '../errors.js';
import type { EmailCampaignJob } from '../repositories/email-campaign-jobs-repository.js';
import type { EmailCampaignRecipient } from '../repositories/email-campaign-recipients-repository.js';

vi.mock('../repositories/email-campaign-jobs-repository.js', () => ({
  EmailCampaignJobsRepository: vi.fn(),
}));

vi.mock('../repositories/email-campaign-recipients-repository.js', () => ({
  EmailCampaignRecipientsRepository: vi.fn(),
}));

vi.mock('../services/domain-resolver.js', () => ({
  DomainResolver: vi.fn(),
}));

vi.mock('../repositories/domain-repository.js', () => ({
  DomainRepository: vi.fn(),
  SendingDomainSchema: {},
}));

vi.mock('../services/spam-checker.js', () => ({
  SpamCheckerService: vi.fn(),
}));

vi.mock('../clients/template-service-client.js', () => {
  class TemplateRenderError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'TemplateRenderError';
    }
  }
  class TemplateServiceUnavailableError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'TemplateServiceUnavailableError';
    }
  }
  return {
    TemplateServiceClient: vi.fn(),
    TemplateRenderError,
    TemplateServiceUnavailableError,
  };
});

function makeKnexStub(): Knex {
  return {} as unknown as Knex;
}

function makeRedisStub(): Redis {
  return { ping: vi.fn().mockResolvedValue('PONG') } as unknown as Redis;
}

function makeQueueStub() {
  return {
    transactionalSend: { close: vi.fn(), add: vi.fn() } as unknown as Queue,
    campaignRecipient: { close: vi.fn(), add: vi.fn() } as unknown as Queue,
  };
}

const makeDomain = () => ({
  id: 'domain-id-1',
  location_id: 'loc-1',
  domain: 'mail.example.com',
  from_name: 'Test',
  from_email: 'test@mail.example.com',
  is_verified: true,
  spam_score_threshold: 5.0,
  sendgrid_domain_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const makeJob = (overrides: Partial<EmailCampaignJob> = {}): EmailCampaignJob => ({
  id: 'job-id-1',
  job_ref: 'ref-1',
  location_id: 'loc-1',
  entity_type: null,
  entity_id: null,
  template_id: 'tmpl-1',
  subject_template: 'Hello {{name}}',
  domain_id: 'domain-id-1',
  scheduled_for: null,
  spam_score: null,
  spam_issues: null,
  status: 'pending',
  total_recipients: 0,
  sent_count: 0,
  failed_count: 0,
  created_by: null,
  created_at: new Date().toISOString(),
  started_at: null,
  completed_at: null,
  ...overrides,
});

const makeRecipient = (overrides: Partial<EmailCampaignRecipient> = {}): EmailCampaignRecipient => ({
  id: 'recip-id-1',
  job_id: 'job-id-1',
  to_email: 'a@example.com',
  context: {},
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

const validBody = {
  job_ref: 'ref-1',
  location_id: 'loc-1',
  template_id: 'tmpl-1',
  subject_template: 'Hello {{name}}',
  recipients: [
    { email: 'a@example.com', context: { name: 'Alice' } },
    { email: 'b@example.com', context: { name: 'Bob' } },
  ],
};

describe('POST /emails/campaigns/send', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockJobsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRecipientsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDomainResolver: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSpamChecker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTemplateClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MockTemplateRenderError: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MockTemplateServiceUnavailableError: any;
  let queues: ReturnType<typeof makeQueueStub>;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  beforeEach(async () => {
    const { EmailCampaignJobsRepository } = await import('../repositories/email-campaign-jobs-repository.js');
    const { EmailCampaignRecipientsRepository } = await import('../repositories/email-campaign-recipients-repository.js');
    const { DomainResolver } = await import('../services/domain-resolver.js');
    const { SpamCheckerService } = await import('../services/spam-checker.js');
    const {
      TemplateServiceClient,
      TemplateRenderError,
      TemplateServiceUnavailableError,
    } = await import('../clients/template-service-client.js');
    MockTemplateRenderError = TemplateRenderError;
    MockTemplateServiceUnavailableError = TemplateServiceUnavailableError;

    mockJobsRepo = {
      create: vi.fn().mockResolvedValue(makeJob()),
      findByJobRef: vi.fn().mockResolvedValue(null),
      setFailed: vi.fn().mockResolvedValue(undefined),
      setSpamCheckFailed: vi.fn().mockResolvedValue(undefined),
      updateSpamScore: vi.fn().mockResolvedValue(undefined),
      setProcessing: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(EmailCampaignJobsRepository).mockImplementation(() => mockJobsRepo);

    mockRecipientsRepo = {
      bulkInsert: vi.fn().mockResolvedValue(undefined),
      findPendingByJobId: vi.fn().mockResolvedValue([
        makeRecipient({ id: 'recip-id-1' }),
        makeRecipient({ id: 'recip-id-2' }),
      ]),
    };
    vi.mocked(EmailCampaignRecipientsRepository).mockImplementation(() => mockRecipientsRepo);

    mockDomainResolver = {
      resolve: vi.fn().mockResolvedValue(makeDomain()),
    };
    vi.mocked(DomainResolver).mockImplementation(() => mockDomainResolver);

    mockSpamChecker = {
      check: vi.fn().mockResolvedValue({ score: 2.0, threshold: 5.0, passed: true, issues: [] }),
    };
    vi.mocked(SpamCheckerService).mockImplementation(() => mockSpamChecker);

    mockTemplateClient = {
      render: vi.fn().mockResolvedValue({ html: '<p>Hello Alice</p>', text: 'Hello Alice' }),
    };
    vi.mocked(TemplateServiceClient).mockImplementation(() => mockTemplateClient);

    queues = makeQueueStub();
    const driver = new MockDriver();
    const eventBus = new EventBusImpl(driver);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    app = await buildApp(makeKnexStub(), eventBus, queues, makeRedisStub());
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('(a) domain not configured → 422', async () => {
    mockDomainResolver.resolve.mockRejectedValue(new DomainNotConfiguredError('loc-1'));

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/campaigns/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'domain_not_configured' });
  });

  it('(a2) domain not verified → 422', async () => {
    mockDomainResolver.resolve.mockRejectedValue(new DomainNotVerifiedError('loc-1'));

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/campaigns/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'domain_not_verified' });
  });

  it('(b) duplicate job_ref → 200 with existing status', async () => {
    const existing = makeJob({ id: 'existing-job', status: 'processing', total_recipients: 5 });
    mockJobsRepo.findByJobRef.mockResolvedValue(existing);

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/campaigns/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      job_id: 'existing-job',
      status: 'processing',
      total_recipients: 5,
    });
    expect(mockJobsRepo.create).not.toHaveBeenCalled();
  });

  it('(c) recipient count > 10000 → 422 recipient_limit_exceeded, no job created', async () => {
    const bigBody = {
      ...validBody,
      recipients: Array.from({ length: 10001 }, (_, i) => ({
        email: `user${i}@example.com`,
        context: {},
      })),
    };

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/campaigns/send',
      payload: bigBody,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'recipient_limit_exceeded', limit: 10000 });
    expect(mockJobsRepo.create).not.toHaveBeenCalled();
  });

  it('(d) template render 4xx → 422 template_render_failed', async () => {
    mockTemplateClient.render.mockRejectedValue(new MockTemplateRenderError('Bad template'));

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/campaigns/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'template_render_failed', job_id: 'job-id-1' });
    expect(mockJobsRepo.setFailed).toHaveBeenCalledWith('job-id-1', 'template_render_failed');
  });

  it('(d2) template service 5xx → 503 template_service_unavailable', async () => {
    mockTemplateClient.render.mockRejectedValue(new MockTemplateServiceUnavailableError('Service down'));

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/campaigns/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'template_service_unavailable', job_id: 'job-id-1' });
    expect(mockJobsRepo.setFailed).toHaveBeenCalledWith('job-id-1', 'template_service_unavailable');
  });

  it('(e) spam check fails → 422 spam_check_failed', async () => {
    mockSpamChecker.check.mockResolvedValue({
      score: 8.5,
      threshold: 5.0,
      passed: false,
      issues: [{ rule: 'PHISHING', description: 'URL detected', score: 3.5 }],
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/campaigns/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(422);
    const json = response.json();
    expect(json).toMatchObject({ error: 'spam_check_failed', job_id: 'job-id-1', score: 8.5 });
    expect(mockJobsRepo.setSpamCheckFailed).toHaveBeenCalledWith('job-id-1', 8.5, expect.any(Array));
  });

  it('(f) success → 202, campaignRecipient.add called once per recipient', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/emails/campaigns/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(202);
    const json = response.json();
    expect(json).toMatchObject({ job_id: 'job-id-1', status: 'processing', total_recipients: 2 });
    expect(queues.campaignRecipient.add).toHaveBeenCalledTimes(2);
    expect(queues.campaignRecipient.add).toHaveBeenCalledWith(
      'send',
      { recipientId: 'recip-id-1' },
      { delay: 0 },
    );
    expect(queues.campaignRecipient.add).toHaveBeenCalledWith(
      'send',
      { recipientId: 'recip-id-2' },
      { delay: 0 },
    );
  });

  it('(g) scheduled_for in past → zero delay on queue.add', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/campaigns/send',
      payload: { ...validBody, scheduled_for: pastDate },
    });

    expect(response.statusCode).toBe(202);
    const calls = vi.mocked(queues.campaignRecipient.add).mock.calls;
    for (const call of calls) {
      expect(call[2]).toEqual({ delay: 0 });
    }
  });
});

describe('GET /emails/campaigns/:jobId', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockJobsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRecipientsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDomainResolver: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSpamChecker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTemplateClient: any;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  beforeEach(async () => {
    const { EmailCampaignJobsRepository } = await import('../repositories/email-campaign-jobs-repository.js');
    const { EmailCampaignRecipientsRepository } = await import('../repositories/email-campaign-recipients-repository.js');
    const { DomainResolver } = await import('../services/domain-resolver.js');
    const { SpamCheckerService } = await import('../services/spam-checker.js');
    const { TemplateServiceClient } = await import('../clients/template-service-client.js');

    mockJobsRepo = {
      findById: vi.fn().mockResolvedValue(makeJob({ status: 'processing', total_recipients: 10, sent_count: 7, failed_count: 1 })),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(EmailCampaignJobsRepository).mockImplementation(() => mockJobsRepo);

    mockRecipientsRepo = {
      findByJobIdPaginated: vi.fn().mockResolvedValue({
        recipients: [makeRecipient()],
        total: 1,
      }),
    };
    vi.mocked(EmailCampaignRecipientsRepository).mockImplementation(() => mockRecipientsRepo);

    mockDomainResolver = { resolve: vi.fn() };
    vi.mocked(DomainResolver).mockImplementation(() => mockDomainResolver);

    mockSpamChecker = { check: vi.fn() };
    vi.mocked(SpamCheckerService).mockImplementation(() => mockSpamChecker);

    mockTemplateClient = { render: vi.fn() };
    vi.mocked(TemplateServiceClient).mockImplementation(() => mockTemplateClient);

    const queues = makeQueueStub();
    const driver = new MockDriver();
    const eventBus = new EventBusImpl(driver);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    app = await buildApp(makeKnexStub(), eventBus, queues, makeRedisStub());
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('(a) GET status → 200 with counts', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/emails/campaigns/job-id-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      job_id: 'job-id-1',
      status: 'processing',
      total_recipients: 10,
      sent_count: 7,
      failed_count: 1,
    });
  });

  it('(b) GET status → 404 for unknown jobId', async () => {
    mockJobsRepo.findById.mockResolvedValue(null);

    const response = await app!.inject({
      method: 'GET',
      url: '/emails/campaigns/unknown-id',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
  });

  it('(c) GET recipients → 200 with pagination', async () => {
    mockRecipientsRepo.findByJobIdPaginated.mockResolvedValue({
      recipients: [makeRecipient({ id: 'r1' }), makeRecipient({ id: 'r2' })],
      total: 2,
    });

    const response = await app!.inject({
      method: 'GET',
      url: '/emails/campaigns/job-id-1/recipients',
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.total).toBe(2);
    expect(json.data).toHaveLength(2);
    expect(mockRecipientsRepo.findByJobIdPaginated).toHaveBeenCalledWith('job-id-1', {
      status: undefined,
      page: 1,
      pageSize: 100,
    });
  });

  it('(d) GET recipients with status filter → filtered results', async () => {
    mockRecipientsRepo.findByJobIdPaginated.mockResolvedValue({
      recipients: [makeRecipient({ status: 'sent' })],
      total: 1,
    });

    const response = await app!.inject({
      method: 'GET',
      url: '/emails/campaigns/job-id-1/recipients?status=sent&page=2',
    });

    expect(response.statusCode).toBe(200);
    expect(mockRecipientsRepo.findByJobIdPaginated).toHaveBeenCalledWith('job-id-1', {
      status: 'sent',
      page: 2,
      pageSize: 100,
    });
  });

  it('(e) DELETE pending job → 200 cancelled', async () => {
    mockJobsRepo.findById.mockResolvedValue(makeJob({ status: 'pending' }));

    const response = await app!.inject({
      method: 'DELETE',
      url: '/emails/campaigns/job-id-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ job_id: 'job-id-1', status: 'cancelled' });
    expect(mockJobsRepo.cancel).toHaveBeenCalledWith('job-id-1');
  });

  it('(f) DELETE processing job → 409', async () => {
    mockJobsRepo.findById.mockResolvedValue(makeJob({ status: 'processing' }));

    const response = await app!.inject({
      method: 'DELETE',
      url: '/emails/campaigns/job-id-1',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'cannot_cancel', status: 'processing' });
    expect(mockJobsRepo.cancel).not.toHaveBeenCalled();
  });

  it('(g) DELETE completed job → 409', async () => {
    mockJobsRepo.findById.mockResolvedValue(makeJob({ status: 'completed' }));

    const response = await app!.inject({
      method: 'DELETE',
      url: '/emails/campaigns/job-id-1',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'cannot_cancel', status: 'completed' });
  });

  it('(h) DELETE unknown job → 404', async () => {
    mockJobsRepo.findById.mockResolvedValue(null);

    const response = await app!.inject({
      method: 'DELETE',
      url: '/emails/campaigns/unknown-id',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
  });
});
