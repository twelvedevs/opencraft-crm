import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';
import type { Knex } from '../db.js';
import type { Queue } from 'bullmq';

vi.mock('../services/spam-checker.js', () => ({
  SpamCheckerService: vi.fn(),
}));

vi.mock('../repositories/domain-repository.js', () => ({
  DomainRepository: vi.fn(),
  SendingDomainSchema: {},
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

const validBody = {
  subject: 'Big Sale Today!',
  html: '<p>Buy now!</p>',
  text: 'Buy now!',
};

describe('POST /emails/spam-check', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockCheckerInstance: any;
  let queues: ReturnType<typeof makeQueueStub>;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  beforeEach(async () => {
    const { SpamCheckerService } = await import('../services/spam-checker.js');

    mockCheckerInstance = {
      check: vi.fn().mockResolvedValue({
        score: 3.0,
        threshold: 5.0,
        passed: true,
        issues: [],
      }),
    };
    vi.mocked(SpamCheckerService).mockImplementation(() => mockCheckerInstance);

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

  it('(a) no location_id — calls check without locationId and returns 200 with result', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/emails/spam-check',
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(mockCheckerInstance.check).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: undefined }),
    );
    const json = response.json();
    expect(json).toMatchObject({ score: 3.0, threshold: 5.0, passed: true, issues: [] });
  });

  it('(b) location_id provided — passes locationId to check', async () => {
    mockCheckerInstance.check.mockResolvedValue({
      score: 2.5,
      threshold: 3.0,
      passed: true,
      issues: [],
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/spam-check',
      payload: { ...validBody, location_id: 'loc-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(mockCheckerInstance.check).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: 'loc-1' }),
    );
    expect(response.json()).toMatchObject({ threshold: 3.0 });
  });

  it('(c) score above threshold — returns passed: false', async () => {
    mockCheckerInstance.check.mockResolvedValue({
      score: 7.5,
      threshold: 5.0,
      passed: false,
      issues: [{ rule: 'PHISHING', description: 'URL detected', score: 2.0 }],
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/spam-check',
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.passed).toBe(false);
    expect(json.score).toBe(7.5);
    expect(json.issues).toHaveLength(1);
  });

  it('(d) score at or below threshold — returns passed: true', async () => {
    mockCheckerInstance.check.mockResolvedValue({
      score: 5.0,
      threshold: 5.0,
      passed: true,
      issues: [],
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/emails/spam-check',
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().passed).toBe(true);
  });
});
