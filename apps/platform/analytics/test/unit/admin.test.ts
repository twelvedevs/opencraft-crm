import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Queue, Job } from 'bullmq';

vi.mock('../../src/env.js', () => ({
  env: {
    ADMIN_RECOMPUTE_KEY: 'secret-key',
  },
}));

// Import after mock is hoisted
const { adminRoutes } = await import('../../src/routes/admin.js');

function makeQueue(jobId: string, job?: Partial<Job>): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: jobId }),
    getJob: vi.fn().mockResolvedValue(job ?? null),
  } as unknown as Queue;
}

describe('admin routes', () => {
  describe('POST /analytics/admin/recompute', () => {
    it('returns 401 when X-Admin-Key is missing', async () => {
      const app = Fastify();
      await app.register(adminRoutes, { queue: makeQueue('j1') });

      const res = await app.inject({
        method: 'POST',
        url: '/analytics/admin/recompute',
        payload: { table: 'metrics_leads_daily', date_range: { from: '2026-01-01', to: '2026-01-31' } },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when X-Admin-Key is wrong', async () => {
      const app = Fastify();
      await app.register(adminRoutes, { queue: makeQueue('j1') });

      const res = await app.inject({
        method: 'POST',
        url: '/analytics/admin/recompute',
        headers: { 'x-admin-key': 'wrong' },
        payload: { table: 'metrics_leads_daily', date_range: { from: '2026-01-01', to: '2026-01-31' } },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for invalid table name', async () => {
      const app = Fastify();
      await app.register(adminRoutes, { queue: makeQueue('j1') });

      const res = await app.inject({
        method: 'POST',
        url: '/analytics/admin/recompute',
        headers: { 'x-admin-key': 'secret-key' },
        payload: { table: 'not_a_real_table', date_range: { from: '2026-01-01', to: '2026-01-31' } },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when date_range is missing', async () => {
      const app = Fastify();
      await app.register(adminRoutes, { queue: makeQueue('j1') });

      const res = await app.inject({
        method: 'POST',
        url: '/analytics/admin/recompute',
        headers: { 'x-admin-key': 'secret-key' },
        payload: { table: 'metrics_leads_daily' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 202 with job_id on valid request', async () => {
      const queue = makeQueue('abc-123');
      const app = Fastify();
      await app.register(adminRoutes, { queue });

      const res = await app.inject({
        method: 'POST',
        url: '/analytics/admin/recompute',
        headers: { 'x-admin-key': 'secret-key' },
        payload: { table: 'metrics_leads_daily', date_range: { from: '2026-01-01', to: '2026-01-31' } },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ job_id: 'abc-123' });
    });

    it('enqueues job with correct data', async () => {
      const queue = makeQueue('j1');
      const app = Fastify();
      await app.register(adminRoutes, { queue });

      await app.inject({
        method: 'POST',
        url: '/analytics/admin/recompute',
        headers: { 'x-admin-key': 'secret-key' },
        payload: { table: 'metrics_pipeline_daily', date_range: { from: '2026-02-01', to: '2026-02-28' } },
      });

      expect(queue.add).toHaveBeenCalledWith(
        'recompute',
        { table: 'metrics_pipeline_daily', date_range: { from: '2026-02-01', to: '2026-02-28' } },
      );
    });
  });

  describe('GET /analytics/admin/recompute/:job_id', () => {
    it('returns 401 when X-Admin-Key is missing', async () => {
      const app = Fastify();
      await app.register(adminRoutes, { queue: makeQueue('j1') });

      const res = await app.inject({
        method: 'GET',
        url: '/analytics/admin/recompute/j1',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when X-Admin-Key is wrong', async () => {
      const app = Fastify();
      await app.register(adminRoutes, { queue: makeQueue('j1') });

      const res = await app.inject({
        method: 'GET',
        url: '/analytics/admin/recompute/j1',
        headers: { 'x-admin-key': 'bad' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when job not found', async () => {
      const queue = makeQueue('j1', undefined); // getJob returns null
      const app = Fastify();
      await app.register(adminRoutes, { queue });

      const res = await app.inject({
        method: 'GET',
        url: '/analytics/admin/recompute/nonexistent',
        headers: { 'x-admin-key': 'secret-key' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns pending status for a waiting job', async () => {
      const mockJob = {
        id: 'j1',
        getState: vi.fn().mockResolvedValue('waiting'),
        returnvalue: null,
        failedReason: null,
      };
      const queue = {
        add: vi.fn(),
        getJob: vi.fn().mockResolvedValue(mockJob),
      } as unknown as Queue;
      const app = Fastify();
      await app.register(adminRoutes, { queue });

      const res = await app.inject({
        method: 'GET',
        url: '/analytics/admin/recompute/j1',
        headers: { 'x-admin-key': 'secret-key' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ job_id: 'j1', status: 'pending', rows_written: null, error: null });
    });

    it('returns active status for an active job', async () => {
      const mockJob = {
        id: 'j2',
        getState: vi.fn().mockResolvedValue('active'),
        returnvalue: null,
        failedReason: null,
      };
      const queue = { add: vi.fn(), getJob: vi.fn().mockResolvedValue(mockJob) } as unknown as Queue;
      const app = Fastify();
      await app.register(adminRoutes, { queue });

      const res = await app.inject({
        method: 'GET',
        url: '/analytics/admin/recompute/j2',
        headers: { 'x-admin-key': 'secret-key' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ job_id: 'j2', status: 'active', rows_written: null, error: null });
    });

    it('returns completed status with rows_written', async () => {
      const mockJob = {
        id: 'j3',
        getState: vi.fn().mockResolvedValue('completed'),
        returnvalue: { rows_written: 99 },
        failedReason: null,
      };
      const queue = { add: vi.fn(), getJob: vi.fn().mockResolvedValue(mockJob) } as unknown as Queue;
      const app = Fastify();
      await app.register(adminRoutes, { queue });

      const res = await app.inject({
        method: 'GET',
        url: '/analytics/admin/recompute/j3',
        headers: { 'x-admin-key': 'secret-key' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ job_id: 'j3', status: 'completed', rows_written: 99, error: null });
    });

    it('returns failed status with error message', async () => {
      const mockJob = {
        id: 'j4',
        getState: vi.fn().mockResolvedValue('failed'),
        returnvalue: null,
        failedReason: 'DB connection lost',
      };
      const queue = { add: vi.fn(), getJob: vi.fn().mockResolvedValue(mockJob) } as unknown as Queue;
      const app = Fastify();
      await app.register(adminRoutes, { queue });

      const res = await app.inject({
        method: 'GET',
        url: '/analytics/admin/recompute/j4',
        headers: { 'x-admin-key': 'secret-key' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ job_id: 'j4', status: 'failed', rows_written: null, error: 'DB connection lost' });
    });
  });
});
