/**
 * Integration test for the generate-report BullMQ worker.
 *
 * Uses real Postgres and real Redis. Mocks:
 *   - analytics-client (no real Analytics Service)
 *   - puppeteer (no real Chromium)
 *   - global fetch (Media Service, Email Service, Notification Service)
 *
 * The schedule-manager is NOT mocked so a real Queue + Worker run on the
 * test Redis. The worker picks up jobs enqueued by the test and we wait for
 * the 'completed' or 'failed' event before asserting DB state.
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// ─── Module mocks (hoisted) ──────────────────────────────────────────────────

vi.mock('../../src/env.js', () => ({
  env: {
    PORT: 3099,
    DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/test',
    REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    ANALYTICS_SERVICE_URL: 'http://analytics-test',
    ANALYTICS_API_KEY: 'test-analytics-key',
    MEDIA_SERVICE_URL: 'http://media-test',
    INTERNAL_API_SECRET: 'test-internal-secret',
    EMAIL_SERVICE_URL: 'http://email-test',
    NOTIFICATION_SERVICE_URL: 'http://notification-test',
    CRM_BASE_URL: 'http://crm-test',
    IDENTITY_JWKS_URL: 'http://localhost:9999/.well-known/jwks.json',
    LOG_LEVEL: 'error',
    LRU_CACHE_MAX: 500,
    LRU_CACHE_TTL_MS: 300000,
  },
}));

vi.mock('../../src/services/analytics-client.js', () => ({
  getLeadMetrics: vi.fn().mockResolvedValue({
    total: 50,
    by_channel: [{ channel: 'google_ads', count: 50 }],
  }),
  getPipelineMetrics: vi.fn().mockResolvedValue({
    by_stage: [
      { stage: 'exam_scheduled', entries: 20 },
      { stage: 'exam_completed', entries: 15 },
    ],
  }),
  getConversionMetrics: vi.fn().mockResolvedValue({
    total: 10,
    by_channel: [{ channel: 'google_ads', count: 10 }],
  }),
  getAdSpendMetrics: vi.fn().mockResolvedValue({
    by_platform: [{ platform: 'google_ads', total_spend: 2500 }],
  }),
  getCoordinatorMetrics: vi.fn().mockResolvedValue({ coordinators: [] }),
  getCampaignMetrics: vi.fn().mockResolvedValue({ campaigns: [] }),
}));

// Puppeteer mock — hoisted handles for reset between tests
const mockPdf = vi.hoisted(() => vi.fn().mockResolvedValue(Buffer.from('fake-pdf-bytes')));
const mockSetContent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSetDefaultTimeout = vi.hoisted(() => vi.fn());
const mockBrowserClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockNewPage = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    setDefaultTimeout: mockSetDefaultTimeout,
    setContent: mockSetContent,
    pdf: mockPdf,
  }),
);
const mockLaunch = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    newPage: mockNewPage,
    close: mockBrowserClose,
  }),
);

vi.mock('puppeteer', () => ({
  default: { launch: mockLaunch },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import type { Job } from 'bullmq';
import {
  HAS_DB,
  HAS_REDIS,
  runMigrations,
  truncateTables,
  cleanup,
  insertConfig,
  insertRun,
  JWKS_RESPONSE,
  USER_ID,
  LOCATION_ID,
} from './helpers.js';

// Import the real queue and worker (no mock for schedule-manager in this file)
import { reportingQueue, queueRedis } from '../../src/services/schedule-manager.js';
import { reportWorker, GENERATE_REPORT_JOB_OPTIONS } from '../../src/jobs/generate-report.js';
import db from '../../src/db.js';
import * as runsRepo from '../../src/repositories/runs.js';
import * as analyticsClient from '../../src/services/analytics-client.js';

// ─── Fetch mock for external services ────────────────────────────────────────

const MEDIA_FILE_ID = 'integration-test-file-001';
const fetchCalls: { url: string; method: string; body?: unknown }[] = [];

function buildFetchMock() {
  return vi.fn().mockImplementation(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      let body: unknown;
      if (init?.body) {
        // body may be FormData or a JSON string
        if (typeof init.body === 'string') {
          try {
            body = JSON.parse(init.body) as unknown;
          } catch {
            body = init.body;
          }
        }
      }

      fetchCalls.push({ url, method, body });

      // JWKS
      if (url.includes('.well-known/jwks.json') || url.includes('/jwks')) {
        return new Response(JWKS_RESPONSE, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Media Service — store
      if (url.includes('/media/internal/store')) {
        return new Response(
          JSON.stringify({ file_id: MEDIA_FILE_ID, urls: { original: 'https://s3.example.com/report.pdf' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Media Service — signed URL
      if (url.includes('/signed-url')) {
        return new Response(
          JSON.stringify({ url: 'https://s3.example.com/presigned' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Email Service
      if (url.includes('/emails/send')) {
        return new Response(
          JSON.stringify({ ok: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Notification Service
      if (url.includes('/notifications/publish')) {
        return new Response(
          JSON.stringify({ ok: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  );
}

// ─── Helper: wait for a specific job to reach completed or failed ─────────────

function waitForJob(
  runId: string,
  event: 'completed' | 'failed',
  timeoutMs = 15000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reportWorker.off('completed', onCompleted);
      reportWorker.off('failed', onFailed);
      reject(new Error(`Timed out waiting for job with runId=${runId}`));
    }, timeoutMs);

    const onCompleted = (job: Job) => {
      if (job.data.report_run_id === runId) {
        clearTimeout(timer);
        reportWorker.off('completed', onCompleted);
        reportWorker.off('failed', onFailed);
        if (event === 'completed') resolve();
        else reject(new Error('Expected job to fail but it completed'));
      }
    };

    const onFailed = (job: Job | undefined, err: Error) => {
      if (job?.data.report_run_id === runId) {
        clearTimeout(timer);
        reportWorker.off('completed', onCompleted);
        reportWorker.off('failed', onFailed);
        if (event === 'failed') resolve();
        else reject(err);
      }
    };

    reportWorker.on('completed', onCompleted);
    reportWorker.on('failed', onFailed);
  });
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB || !HAS_REDIS)('generate-report BullMQ worker (integration)', () => {
  let fetchMock: ReturnType<typeof buildFetchMock>;

  beforeAll(async () => {
    await runMigrations();
    // Flush the queue so stale jobs from prior runs don't interfere
    await reportingQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await reportWorker.close();
    await reportingQueue.close();
    await queueRedis.quit();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();

    fetchCalls.length = 0;
    fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    // Reset puppeteer mocks
    mockPdf.mockResolvedValue(Buffer.from('fake-pdf-bytes'));
    mockSetContent.mockResolvedValue(undefined);
    mockBrowserClose.mockResolvedValue(undefined);
    mockNewPage.mockResolvedValue({
      setDefaultTimeout: mockSetDefaultTimeout,
      setContent: mockSetContent,
      pdf: mockPdf,
    });
    mockLaunch.mockResolvedValue({ newPage: mockNewPage, close: mockBrowserClose });

    // Reset analytics mocks to defaults
    vi.mocked(analyticsClient.getLeadMetrics).mockResolvedValue({
      total: 50,
      by_channel: [{ channel: 'google_ads', count: 50 }],
    });
    vi.mocked(analyticsClient.getConversionMetrics).mockResolvedValue({
      total: 10,
      by_channel: [],
    });
    vi.mocked(analyticsClient.getPipelineMetrics).mockResolvedValue({
      by_stage: [
        { stage: 'exam_scheduled', entries: 20 },
        { stage: 'exam_completed', entries: 15 },
      ],
    });
    vi.mocked(analyticsClient.getAdSpendMetrics).mockResolvedValue({
      by_platform: [{ platform: 'google_ads', total_spend: 2500 }],
    });
    vi.mocked(analyticsClient.getCoordinatorMetrics).mockResolvedValue({ coordinators: [] });
    vi.mocked(analyticsClient.getCampaignMetrics).mockResolvedValue({ campaigns: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Successful on-demand run ──────────────────────────────────────────────

  it('processes job → run status transitions pending → done', async () => {
    const config = await insertConfig({
      created_by: USER_ID,
      parameters: { period_type: 'last_30d', location_ids: [LOCATION_ID] },
    });
    const run = await insertRun(config.id, {
      status: 'pending',
      triggered_by: USER_ID,
    });

    await reportingQueue.add(
      'generate-report',
      {
        report_config_id: config.id,
        report_run_id: run.id,
        format: 'pdf',
      },
      { ...GENERATE_REPORT_JOB_OPTIONS, attempts: 1 },
    );

    await waitForJob(run.id, 'completed');

    const updatedRun = await runsRepo.findById(db, run.id);
    expect(updatedRun?.status).toBe('done');
    expect(updatedRun?.media_file_id).toBe(MEDIA_FILE_ID);
    expect(updatedRun?.completed_at).not.toBeNull();
  });

  it('Media Service upload includes uploaded_by = SERVICE_CALLER_ID', async () => {
    const config = await insertConfig({
      created_by: USER_ID,
      parameters: { period_type: 'last_30d' },
    });
    const run = await insertRun(config.id, { status: 'pending', triggered_by: USER_ID });

    // Capture the raw FormData body so we can inspect uploaded_by
    let capturedFormData: FormData | undefined;
    const originalFetch = fetchMock;
    fetchMock = vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes('/media/internal/store') && init?.body instanceof FormData) {
        capturedFormData = init.body as FormData;
      }
      return originalFetch(input, init);
    }) as ReturnType<typeof buildFetchMock>;
    vi.stubGlobal('fetch', fetchMock);

    await reportingQueue.add(
      'generate-report',
      { report_config_id: config.id, report_run_id: run.id, format: 'pdf' },
      { ...GENERATE_REPORT_JOB_OPTIONS, attempts: 1 },
    );

    await waitForJob(run.id, 'completed');

    const mediaCall = fetchCalls.find((c) => c.url.includes('/media/internal/store'));
    expect(mediaCall).toBeDefined();
    expect(mediaCall?.method).toBe('POST');
    expect(capturedFormData?.get('uploaded_by')).toBe('00000000-0000-0000-0000-000000reporting');
  });

  // ─── Email delivery ────────────────────────────────────────────────────────

  it('calls Email Service when recipient_emails is present', async () => {
    const config = await insertConfig({
      created_by: USER_ID,
      parameters: { period_type: 'last_30d' },
    });
    const run = await insertRun(config.id, {
      status: 'pending',
      triggered_by: USER_ID,
      recipient_emails: ['recipient@example.com'],
    });

    await reportingQueue.add(
      'generate-report',
      {
        report_config_id: config.id,
        report_run_id: run.id,
        format: 'pdf',
        recipient_emails: ['recipient@example.com'],
      },
      { ...GENERATE_REPORT_JOB_OPTIONS, attempts: 1 },
    );

    await waitForJob(run.id, 'completed');

    const emailCall = fetchCalls.find((c) => c.url.includes('/emails/send'));
    expect(emailCall).toBeDefined();
  });

  // ─── Notification Service ──────────────────────────────────────────────────

  it('calls Notification Service for on-demand run (no report_schedule_id)', async () => {
    const config = await insertConfig({
      created_by: USER_ID,
      parameters: { period_type: 'last_30d' },
    });
    // No report_schedule_id → on-demand
    const run = await insertRun(config.id, { status: 'pending', triggered_by: USER_ID });

    await reportingQueue.add(
      'generate-report',
      { report_config_id: config.id, report_run_id: run.id, format: 'pdf' },
      { ...GENERATE_REPORT_JOB_OPTIONS, attempts: 1 },
    );

    await waitForJob(run.id, 'completed');

    const notifCall = fetchCalls.find((c) => c.url.includes('/notifications/publish'));
    expect(notifCall).toBeDefined();
  });

  it('does NOT call Notification Service for scheduled run (report_schedule_id present)', async () => {
    const config = await insertConfig({
      created_by: USER_ID,
      parameters: { period_type: 'last_30d' },
    });
    const run = await insertRun(config.id, {
      status: 'pending',
      triggered_by: USER_ID,
      report_schedule_id: '00000000-0000-0000-0000-scheduled0001',
    });

    await reportingQueue.add(
      'generate-report',
      {
        report_config_id: config.id,
        report_run_id: run.id,
        format: 'pdf',
        report_schedule_id: '00000000-0000-0000-0000-scheduled0001',
      },
      { ...GENERATE_REPORT_JOB_OPTIONS, attempts: 1 },
    );

    await waitForJob(run.id, 'completed');

    const notifCall = fetchCalls.find((c) => c.url.includes('/notifications/publish'));
    expect(notifCall).toBeUndefined();
  });

  // ─── Failure path ──────────────────────────────────────────────────────────

  it('on worker failure: run status becomes failed with error_message', async () => {
    const config = await insertConfig({
      created_by: USER_ID,
      parameters: { period_type: 'last_30d' },
    });
    const run = await insertRun(config.id, { status: 'pending', triggered_by: USER_ID });

    // Make analytics fail → renderReport will throw
    vi.mocked(analyticsClient.getLeadMetrics).mockRejectedValue(
      new Error('Analytics service unavailable'),
    );

    // Single attempt so the failure is immediate (no exponential backoff delay)
    await reportingQueue.add(
      'generate-report',
      { report_config_id: config.id, report_run_id: run.id, format: 'pdf' },
      { attempts: 1, removeOnFail: false },
    );

    // Wait for the 'failed' event
    await waitForJob(run.id, 'failed');

    const updatedRun = await runsRepo.findById(db, run.id);
    expect(updatedRun?.status).toBe('failed');
    expect(updatedRun?.error_message).toContain('Analytics service unavailable');
  });
});
