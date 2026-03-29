import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';
import type { Knex } from '../db.js';
import type { Queue } from 'bullmq';
import { DomainNotConfiguredError, DomainNotVerifiedError } from '../errors.js';
import type { EmailSend } from '../repositories/email-sends-repository.js';
import type { SendingDomain } from '../repositories/domain-repository.js';

vi.mock('../repositories/email-sends-repository.js', () => ({
  EmailSendsRepository: vi.fn(),
}));

vi.mock('../services/domain-resolver.js', () => ({
  DomainResolver: vi.fn(),
}));

vi.mock('../repositories/domain-repository.js', () => ({
  DomainRepository: vi.fn(),
  SendingDomainSchema: {},
}));

function makeKnexStub(): Knex {
  return {} as unknown as Knex;
}

function makeQueueStub() {
  return { transactionalSend: { close: vi.fn(), add: vi.fn() } as unknown as Queue };
}

const makeDomain = (): SendingDomain => ({
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

const makeEmailSend = (overrides: Partial<EmailSend> = {}): EmailSend => ({
  id: 'send-id-1',
  dedup_key: 'dedup-1',
  location_id: 'loc-1',
  domain_id: 'domain-id-1',
  entity_type: null,
  entity_id: null,
  to_email: 'recipient@example.com',
  subject: 'Hello',
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

const validBody = {
  dedup_key: 'dedup-1',
  location_id: 'loc-1',
  to: 'recipient@example.com',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
};

describe('POST /emails/send', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRepoInstance: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockResolverInstance: any;
  let queues: ReturnType<typeof makeQueueStub>;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  beforeEach(async () => {
    const { EmailSendsRepository } = await import('../repositories/email-sends-repository.js');
    const { DomainResolver } = await import('../services/domain-resolver.js');

    mockRepoInstance = {
      findByDedupKey: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(makeEmailSend()),
    };
    vi.mocked(EmailSendsRepository).mockImplementation(() => mockRepoInstance);

    mockResolverInstance = {
      resolve: vi.fn().mockResolvedValue(makeDomain()),
    };
    vi.mocked(DomainResolver).mockImplementation(() => mockResolverInstance);

    queues = makeQueueStub();
    const driver = new MockDriver();
    const eventBus = new EventBusImpl(driver);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  it('returns 422 with domain_not_configured when DomainNotConfiguredError is thrown', async () => {
    mockResolverInstance.resolve.mockRejectedValue(new DomainNotConfiguredError('loc-1'));

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'domain_not_configured', location_id: 'loc-1' });
  });

  it('returns 422 with domain_not_verified when DomainNotVerifiedError is thrown', async () => {
    mockResolverInstance.resolve.mockRejectedValue(new DomainNotVerifiedError('loc-1'));

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'domain_not_verified', location_id: 'loc-1' });
  });

  it('returns 200 with existing email_id when dedup_key already exists (no queue.add call)', async () => {
    const existing = makeEmailSend({ id: 'existing-id', status: 'sent' });
    mockRepoInstance.findByDedupKey.mockResolvedValue(existing);

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ email_id: 'existing-id', status: 'sent' });
    expect(queues.transactionalSend.add).not.toHaveBeenCalled();
  });

  it('returns 200 with email_id and queued status on success, and calls queue.add once', async () => {
    const send = makeEmailSend({ id: 'new-send-id', status: 'queued' });
    mockRepoInstance.create.mockResolvedValue(send);

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/send',
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ email_id: 'new-send-id', status: 'queued' });
    expect(queues.transactionalSend.add).toHaveBeenCalledOnce();
    expect(queues.transactionalSend.add).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({ emailSendId: 'new-send-id' }),
      expect.objectContaining({ attempts: 5 }),
    );
  });
});
