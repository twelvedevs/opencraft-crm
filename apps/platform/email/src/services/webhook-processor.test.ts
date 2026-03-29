import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from '../db.js';
import type { EventBus } from '@ortho/event-bus';
import type { EmailCampaignRecipient } from '../repositories/email-campaign-recipients-repository.js';
import type { EmailCampaignJob } from '../repositories/email-campaign-jobs-repository.js';
import type { EmailSend } from '../repositories/email-sends-repository.js';

vi.mock('../repositories/email-campaign-recipients-repository.js', () => ({
  EmailCampaignRecipientsRepository: vi.fn(),
}));
vi.mock('../repositories/email-campaign-jobs-repository.js', () => ({
  EmailCampaignJobsRepository: vi.fn(),
}));
vi.mock('../repositories/email-sends-repository.js', () => ({
  EmailSendsRepository: vi.fn(),
}));
vi.mock('../repositories/email-recipient-clicks-repository.js', () => ({
  EmailRecipientClicksRepository: vi.fn(),
}));
vi.mock('../repositories/email-send-clicks-repository.js', () => ({
  EmailSendClicksRepository: vi.fn(),
}));

const makeRecipient = (overrides: Partial<EmailCampaignRecipient> = {}): EmailCampaignRecipient => ({
  id: 'rec-1',
  job_id: 'job-1',
  to_email: 'user@example.com',
  context: {},
  sendgrid_message_id: 'sg-msg-1',
  status: 'sent',
  attempt: 1,
  error: null,
  sent_at: null,
  delivered_at: null,
  opened_at: null,
  clicked_at: null,
  bounced_at: null,
  ...overrides,
});

const makeJob = (overrides: Partial<EmailCampaignJob> = {}): EmailCampaignJob => ({
  id: 'job-1',
  job_ref: 'ref-1',
  location_id: 'loc-1',
  entity_type: 'lead',
  entity_id: 'lead-1',
  template_id: 'tmpl-1',
  subject_template: 'Hello',
  domain_id: 'domain-1',
  scheduled_for: null,
  spam_score: null,
  spam_issues: null,
  status: 'processing',
  total_recipients: 10,
  sent_count: 5,
  failed_count: 0,
  created_by: null,
  created_at: new Date().toISOString(),
  started_at: null,
  completed_at: null,
  ...overrides,
});

const makeSend = (overrides: Partial<EmailSend> = {}): EmailSend => ({
  id: 'send-1',
  dedup_key: 'dedup-1',
  location_id: 'loc-2',
  domain_id: 'domain-1',
  entity_type: 'lead',
  entity_id: 'lead-2',
  to_email: 'txn@example.com',
  subject: 'Hello',
  sendgrid_message_id: 'sg-msg-2',
  status: 'sent',
  attempt: 1,
  error: null,
  created_at: new Date().toISOString(),
  sent_at: null,
  delivered_at: null,
  opened_at: null,
  clicked_at: null,
  bounced_at: null,
  ...overrides,
});

describe('WebhookProcessor', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRecipientsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockJobsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSendsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRecipientClicksRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSendClicksRepo: any;
  let mockEventBus: EventBus;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processor: any;

  beforeEach(async () => {
    const { EmailCampaignRecipientsRepository } = await import(
      '../repositories/email-campaign-recipients-repository.js'
    );
    const { EmailCampaignJobsRepository } = await import(
      '../repositories/email-campaign-jobs-repository.js'
    );
    const { EmailSendsRepository } = await import('../repositories/email-sends-repository.js');
    const { EmailRecipientClicksRepository } = await import(
      '../repositories/email-recipient-clicks-repository.js'
    );
    const { EmailSendClicksRepository } = await import(
      '../repositories/email-send-clicks-repository.js'
    );

    mockRecipientsRepo = {
      findBySendgridMessageId: vi.fn().mockResolvedValue(null),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      markOpenedFromWebhook: vi.fn().mockResolvedValue(undefined),
      markClickedFromWebhook: vi.fn().mockResolvedValue(undefined),
      markBouncedFromWebhook: vi.fn().mockResolvedValue(undefined),
      markSpamReported: vi.fn().mockResolvedValue(undefined),
      markUnsubscribed: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(EmailCampaignRecipientsRepository).mockImplementation(() => mockRecipientsRepo);

    mockJobsRepo = {
      findById: vi.fn().mockResolvedValue(makeJob()),
    };
    vi.mocked(EmailCampaignJobsRepository).mockImplementation(() => mockJobsRepo);

    mockSendsRepo = {
      findBySendgridMessageId: vi.fn().mockResolvedValue(null),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      markOpened: vi.fn().mockResolvedValue(undefined),
      markClicked: vi.fn().mockResolvedValue(undefined),
      markBouncedFromWebhook: vi.fn().mockResolvedValue(undefined),
      markSpamReported: vi.fn().mockResolvedValue(undefined),
      markUnsubscribed: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(EmailSendsRepository).mockImplementation(() => mockSendsRepo);

    mockRecipientClicksRepo = {
      insert: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(EmailRecipientClicksRepository).mockImplementation(() => mockRecipientClicksRepo);

    mockSendClicksRepo = {
      insert: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(EmailSendClicksRepository).mockImplementation(() => mockSendClicksRepo);

    mockEventBus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };

    const { WebhookProcessor } = await import('./webhook-processor.js');
    processor = new WebhookProcessor({} as Knex, mockEventBus);
  });

  const baseEvent = {
    sg_message_id: 'sg-msg-1',
    email: 'user@example.com',
    timestamp: 1711720000,
  };

  it('(a) sg_message_id not found in either repo — no DB calls, no events published', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(null);
    mockSendsRepo.findBySendgridMessageId.mockResolvedValue(null);

    await processor.processEvent({ ...baseEvent, event: 'delivered' });

    expect(mockRecipientsRepo.markDelivered).not.toHaveBeenCalled();
    expect(mockSendsRepo.markDelivered).not.toHaveBeenCalled();
    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('(b) campaign recipient delivered — markDelivered called, email.delivered published', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(makeRecipient());

    await processor.processEvent({ ...baseEvent, event: 'delivered' });

    expect(mockRecipientsRepo.markDelivered).toHaveBeenCalledWith('rec-1', expect.any(Date));
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.delivered',
        entity_type: 'lead',
        entity_id: 'lead-1',
        payload: expect.objectContaining({
          email_id: 'rec-1',
          to_email: 'user@example.com',
          location_id: 'loc-1',
          campaign_job_id: 'job-1',
        }),
      }),
    );
  });

  it('(c) campaign recipient open — markOpenedFromWebhook called, email.opened published', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(makeRecipient());

    await processor.processEvent({ ...baseEvent, event: 'open' });

    expect(mockRecipientsRepo.markOpenedFromWebhook).toHaveBeenCalledWith('rec-1', expect.any(Date));
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.opened',
        payload: expect.objectContaining({ email_id: 'rec-1', campaign_job_id: 'job-1' }),
      }),
    );
  });

  it('(d) campaign recipient click — markClickedFromWebhook + recipientClicksRepo.insert + email.clicked with url', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(makeRecipient());

    await processor.processEvent({ ...baseEvent, event: 'click', url: 'https://example.com' });

    expect(mockRecipientsRepo.markClickedFromWebhook).toHaveBeenCalledWith('rec-1', expect.any(Date));
    expect(mockRecipientClicksRepo.insert).toHaveBeenCalledWith('rec-1', 'https://example.com');
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.clicked',
        payload: expect.objectContaining({ url: 'https://example.com', campaign_job_id: 'job-1' }),
      }),
    );
  });

  it('(e) campaign recipient hard bounce — markBouncedFromWebhook + email.bounced with to_address', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(makeRecipient());

    await processor.processEvent({ ...baseEvent, event: 'bounce', type: 'bounce' });

    expect(mockRecipientsRepo.markBouncedFromWebhook).toHaveBeenCalledWith('rec-1', expect.any(Date));
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.bounced',
        payload: expect.objectContaining({
          to_address: 'user@example.com',
          bounce_type: 'hard',
          campaign_job_id: 'job-1',
        }),
      }),
    );
  });

  it('(f) campaign recipient bounce blocked — no-op', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(makeRecipient());

    await processor.processEvent({ ...baseEvent, event: 'bounce', type: 'blocked' });

    expect(mockRecipientsRepo.markBouncedFromWebhook).not.toHaveBeenCalled();
    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('(g) campaign recipient spamreport — markSpamReported + email.spam_reported', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(makeRecipient());

    await processor.processEvent({ ...baseEvent, event: 'spamreport' });

    expect(mockRecipientsRepo.markSpamReported).toHaveBeenCalledWith('rec-1');
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.spam_reported',
        payload: expect.objectContaining({ to_email: 'user@example.com', location_id: 'loc-1' }),
      }),
    );
  });

  it('(h) campaign recipient unsubscribe — markUnsubscribed + email.unsubscribed', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(makeRecipient());

    await processor.processEvent({ ...baseEvent, event: 'unsubscribe' });

    expect(mockRecipientsRepo.markUnsubscribed).toHaveBeenCalledWith('rec-1');
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.unsubscribed',
        payload: expect.objectContaining({ to_email: 'user@example.com', location_id: 'loc-1' }),
      }),
    );
  });

  it('(i) transactional click — markClicked + sendClicksRepo.insert + email.clicked', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(null);
    mockSendsRepo.findBySendgridMessageId.mockResolvedValue(makeSend());

    await processor.processEvent({ ...baseEvent, event: 'click', url: 'https://txn.example.com' });

    expect(mockSendsRepo.markClicked).toHaveBeenCalledWith('send-1', expect.any(Date));
    expect(mockSendClicksRepo.insert).toHaveBeenCalledWith('send-1', 'https://txn.example.com');
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.clicked',
        payload: expect.objectContaining({ url: 'https://txn.example.com', email_id: 'send-1' }),
      }),
    );
  });

  it('(j) transactional spamreport — markSpamReported called, email.spam_reported published', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(null);
    mockSendsRepo.findBySendgridMessageId.mockResolvedValue(makeSend());

    await processor.processEvent({ ...baseEvent, event: 'spamreport' });

    expect(mockSendsRepo.markSpamReported).toHaveBeenCalledWith('send-1');
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'email.spam_reported',
        payload: expect.objectContaining({ to_email: 'txn@example.com', location_id: 'loc-2' }),
      }),
    );
  });

  it('(k) processBatch with one failing event — other events still processed', async () => {
    mockRecipientsRepo.findBySendgridMessageId
      .mockResolvedValueOnce(makeRecipient({ id: 'rec-A' }))
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce(makeRecipient({ id: 'rec-C' }));

    const events = [
      { ...baseEvent, event: 'delivered' },
      { ...baseEvent, event: 'delivered' },
      { ...baseEvent, event: 'delivered' },
    ];

    await processor.processBatch(events);

    expect(mockRecipientsRepo.markDelivered).toHaveBeenCalledTimes(2);
    expect(mockEventBus.publish).toHaveBeenCalledTimes(2);
  });

  it('(l) deferred event — complete no-op', async () => {
    mockRecipientsRepo.findBySendgridMessageId.mockResolvedValue(makeRecipient());

    await processor.processEvent({ ...baseEvent, event: 'deferred' });

    expect(mockRecipientsRepo.markDelivered).not.toHaveBeenCalled();
    expect(mockRecipientsRepo.markOpenedFromWebhook).not.toHaveBeenCalled();
    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });
});
