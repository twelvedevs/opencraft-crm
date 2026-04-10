/**
 * Shared integration-test infrastructure for the Reporting Service.
 *
 * Each test file MUST mock '../../src/env.js' (and '../../src/services/schedule-manager.js'
 * for route tests) via vi.mock BEFORE importing this module, so that the
 * module-level Knex singleton in db.js uses the correct DATABASE_URL.
 */

import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { createSigner } from 'fast-jwt';
import { createLogger } from '@ortho/logger';

// Route imports — these use the module-level `db` singleton (from the mocked env)
import { healthRoutes } from '../../src/routes/health.js';
import { dashboardRoutes } from '../../src/routes/dashboard.js';
import { channelPerformanceRoutes } from '../../src/routes/metrics/channel-performance.js';
import { locationComparisonRoutes } from '../../src/routes/metrics/location-comparison.js';
import { coordinatorPerformanceRoutes } from '../../src/routes/metrics/coordinator-performance.js';
import { campaignAnalyticsRoutes } from '../../src/routes/metrics/campaign-analytics.js';
import { reportConfigRoutes } from '../../src/routes/report-configs.js';
import { scheduleRoutes } from '../../src/routes/schedules.js';
import { runRoutes } from '../../src/routes/runs.js';
import { configRoutes } from '../../src/routes/config.js';

// Repository imports for data-setup helpers (same `db` singleton)
import db from '../../src/db.js';
import * as configsRepo from '../../src/repositories/report-configs.js';
import * as schedulesRepo from '../../src/repositories/schedules.js';
import * as runsRepo from '../../src/repositories/runs.js';
import * as revenueConfigRepo from '../../src/repositories/revenue-config.js';

// ─── Service availability guards ────────────────────────────────────────────

const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];

export const HAS_DB =
  !!DATABASE_URL && DATABASE_URL !== 'postgresql://localhost:5432/test';
export const HAS_REDIS =
  !!REDIS_URL && REDIS_URL !== 'redis://localhost:6379';

// ─── Test constants ──────────────────────────────────────────────────────────

export const LOCATION_ID = '00000000-0000-0000-0000-000000000001';
export const LOCATION_ID_2 = '00000000-0000-0000-0000-000000000002';
export const USER_ID = 'test-user-1';
export const MANAGER_ID = 'test-manager-1';

// ─── JWT infrastructure ──────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const jwk = createPublicKey(publicKey as string).export({ format: 'jwk' });
const TEST_KID = 'test-key-1';

export const JWKS_RESPONSE = JSON.stringify({
  keys: [{ ...jwk, kid: TEST_KID, use: 'sig', alg: 'RS256' }],
});

const sign = createSigner({
  key: privateKey as string,
  algorithm: 'RS256',
  kid: TEST_KID,
});

export function makeJwt(payload?: {
  sub?: string;
  role?: string;
  locations?: string[];
}): string {
  return sign({
    sub: payload?.sub ?? USER_ID,
    role: payload?.role ?? 'marketing_staff',
    locations: payload?.locations ?? [LOCATION_ID],
    must_change_password: false,
  });
}

// ─── Test Fastify app ────────────────────────────────────────────────────────

/**
 * Builds a Fastify instance with all reporting routes registered, plus a JWKS
 * fetch interceptor so authPlugin can verify test JWTs without a real identity
 * service.
 *
 * Returns both the app and a teardown function that closes the app.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  // Intercept JWKS fetches for the authPlugin
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url.includes('.well-known/jwks.json') || url.includes('/jwks')) {
      return new Response(JWKS_RESPONSE, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Default: generic OK response (callers mock specific URLs if needed)
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } as typeof globalThis.fetch;

  const log = createLogger('crm-reporting-test');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);

  // Public routes (health)
  await app.register(healthRoutes);

  // Authenticated scope
  await app.register(async (scope) => {
    await scope.register(authPlugin, {
      jwksUrl: 'http://localhost:9999/.well-known/jwks.json',
    });

    await scope.register(dashboardRoutes);
    await scope.register(channelPerformanceRoutes);
    await scope.register(locationComparisonRoutes);
    await scope.register(coordinatorPerformanceRoutes);
    await scope.register(campaignAnalyticsRoutes);
    await scope.register(reportConfigRoutes);
    await scope.register(scheduleRoutes);
    await scope.register(runRoutes);
    await scope.register(configRoutes);
  });

  // Restore fetch after app is ready (tests that need custom fetch set it themselves)
  void realFetch; // keep reference for potential restoration

  return app;
}

// ─── DB lifecycle helpers ────────────────────────────────────────────────────

export async function runMigrations(): Promise<void> {
  await db.migrate.latest({
    directory: './migrations',
    schemaName: 'crm_reporting',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  });
}

export async function rollbackMigrations(): Promise<void> {
  await db.migrate.rollback(
    {
      directory: './migrations',
      schemaName: 'crm_reporting',
      tableName: 'knex_migrations',
      loadExtensions: ['.ts'],
    },
    true,
  );
}

export async function truncateTables(): Promise<void> {
  await db.raw(`
    TRUNCATE
      crm_reporting.report_runs,
      crm_reporting.report_schedules,
      crm_reporting.report_configs,
      crm_reporting.location_revenue_config
    CASCADE
  `);
}

export async function cleanup(): Promise<void> {
  await rollbackMigrations();
  await db.destroy();
}

// ─── Data factories ──────────────────────────────────────────────────────────

export async function insertConfig(
  overrides: {
    name?: string;
    report_type?: string;
    parameters?: Record<string, unknown>;
    created_by?: string;
  } = {},
) {
  return configsRepo.create(
    db,
    {
      name: overrides.name ?? 'Test Report',
      report_type: (overrides.report_type ?? 'weekly_summary') as
        | 'weekly_summary'
        | 'monthly_executive'
        | 'channel_deep_dive'
        | 'coordinator_productivity'
        | 'lead_source',
      parameters: overrides.parameters as Record<string, unknown> | undefined,
    },
    overrides.created_by ?? USER_ID,
  );
}

export async function insertRun(
  configId: string,
  overrides: {
    status?: string;
    format?: string;
    triggered_by?: string;
    media_file_id?: string;
    recipient_emails?: string[];
    report_schedule_id?: string;
  } = {},
) {
  const run = await runsRepo.create(db, {
    report_config_id: configId,
    report_schedule_id: overrides.report_schedule_id,
    triggered_by: overrides.triggered_by ?? USER_ID,
    format: overrides.format ?? 'pdf',
    status: overrides.status ?? 'pending',
    recipient_emails: overrides.recipient_emails,
  });

  if (overrides.media_file_id) {
    await runsRepo.updateStatus(db, run.id, overrides.status ?? 'done', {
      media_file_id: overrides.media_file_id,
      completed_at: new Date(),
    });
    return (await runsRepo.findById(db, run.id))!;
  }

  return run;
}

export async function insertSchedule(
  configId: string,
  overrides: {
    frequency?: 'daily' | 'weekly' | 'monthly';
    hour_utc?: number;
    day_of_week?: number;
    day_of_month?: number;
    recipient_emails?: string[];
    format?: 'pdf' | 'csv';
    active?: boolean;
    created_by?: string;
  } = {},
) {
  return schedulesRepo.create(
    db,
    {
      report_config_id: configId,
      frequency: overrides.frequency ?? 'daily',
      hour_utc: overrides.hour_utc ?? 9,
      day_of_week: overrides.day_of_week,
      day_of_month: overrides.day_of_month,
      recipient_emails: overrides.recipient_emails ?? ['test@example.com'],
      format: overrides.format ?? 'pdf',
      active: overrides.active ?? true,
    },
    overrides.created_by ?? USER_ID,
  );
}

export async function insertRevenueConfig(
  locationId: string,
  avgContractValue = 5000,
  updatedBy = USER_ID,
) {
  return revenueConfigRepo.upsert(db, locationId, avgContractValue, updatedBy);
}
