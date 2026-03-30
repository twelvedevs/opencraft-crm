import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import { buildApp } from '../../src/app.js';

const SECRET = 'test-secret-for-lifecycle';

async function signToken(claims: object): Promise<string> {
  const key = new TextEncoder().encode(SECRET);
  return new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(key);
}

// Mock TemplatesRepo before any imports resolve
vi.mock('../../src/repositories/templates.js', () => {
  const mockRepo = {
    findById: vi.fn(),
    activate: vi.fn(),
    disable: vi.fn(),
    enable: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    findVersionContent: vi.fn(),
    updateVersionInPlace: vi.fn(),
    insertNewVersion: vi.fn(),
    updateTemplateGroup: vi.fn(),
  };
  return {
    TemplatesRepo: vi.fn().mockImplementation(() => mockRepo),
    _mockRepo: mockRepo,
  };
});

// Access the shared mock repo instance
const { _mockRepo: repo } = await import('../../src/repositories/templates.js') as unknown as {
  _mockRepo: {
    findById: ReturnType<typeof vi.fn>;
    activate: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
  };
};

function makeDraftTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl-1',
    name: 'Test Template',
    channel: 'sms',
    status: 'draft',
    active_version: null,
    current_version: 1,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// Minimal Knex mock that satisfies app decorators
const mockDb = {} as unknown as import('knex').Knex;

describe('Lifecycle routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp(mockDb, SECRET);
  });

  // ─── Activate ─────────────────────────────────────────────────────────────

  describe('POST /templates/:id/activate', () => {
    it('returns 200 with active_version set when activating a draft template', async () => {
      const draft = makeDraftTemplate({ current_version: 1, active_version: null });
      const activated = { ...draft, active_version: 1, status: 'active' };
      repo.findById.mockResolvedValue(draft);
      repo.activate.mockResolvedValue(activated);

      const token = await signToken({ sub: 'mgr-1', roles: ['marketing_staff', 'marketing_manager'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/activate',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.active_version).toBe(1);
      expect(body.status).toBe('active');
    });

    it('returns 200 with active_version incremented when re-activating a template with pending draft', async () => {
      const existing = makeDraftTemplate({ current_version: 3, active_version: 2, status: 'active' });
      const activated = { ...existing, active_version: 3 };
      repo.findById.mockResolvedValue(existing);
      repo.activate.mockResolvedValue(activated);

      const token = await signToken({ sub: 'mgr-1', roles: ['marketing_staff', 'marketing_manager'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/activate',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.active_version).toBe(3);
    });

    it('returns 403 when called with marketing_staff role', async () => {
      const token = await signToken({ sub: 'staff-1', roles: ['marketing_staff'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/activate',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 when template does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      const token = await signToken({ sub: 'mgr-1', roles: ['marketing_staff', 'marketing_manager'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-999/activate',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── Disable ──────────────────────────────────────────────────────────────

  describe('POST /templates/:id/disable', () => {
    it('returns 200 with no warning when disabling an active template', async () => {
      const active = makeDraftTemplate({ status: 'active', active_version: 1 });
      const disabled = { ...active, status: 'disabled' };
      repo.findById.mockResolvedValue(active);
      repo.disable.mockResolvedValue(disabled);

      const token = await signToken({ sub: 'mgr-1', roles: ['marketing_staff', 'marketing_manager'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/disable',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('disabled');
      expect(body.warning).toBeUndefined();
    });

    it('returns 200 with warning when disabling a draft template that was never activated', async () => {
      const draft = makeDraftTemplate({ status: 'draft', active_version: null });
      const disabled = { ...draft, status: 'disabled' };
      repo.findById.mockResolvedValue(draft);
      repo.disable.mockResolvedValue(disabled);

      const token = await signToken({ sub: 'mgr-1', roles: ['marketing_staff', 'marketing_manager'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/disable',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('disabled');
      expect(body.warning).toBe('Template has no active version; it was never activated');
    });

    it('returns 400 when template is already disabled', async () => {
      const disabled = makeDraftTemplate({ status: 'disabled', active_version: 1 });
      repo.findById.mockResolvedValue(disabled);

      const token = await signToken({ sub: 'mgr-1', roles: ['marketing_staff', 'marketing_manager'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/disable',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Template is already disabled');
    });

    it('returns 403 when called with marketing_staff role', async () => {
      const token = await signToken({ sub: 'staff-1', roles: ['marketing_staff'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/disable',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ─── Enable ───────────────────────────────────────────────────────────────

  describe('POST /templates/:id/enable', () => {
    it('returns 200 when re-enabling a disabled template with active_version set', async () => {
      const disabled = makeDraftTemplate({ status: 'disabled', active_version: 1 });
      const enabled = { ...disabled, status: 'active' };
      repo.findById.mockResolvedValue(disabled);
      repo.enable.mockResolvedValue(enabled);

      const token = await signToken({ sub: 'mgr-1', roles: ['marketing_staff', 'marketing_manager'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/enable',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('active');
    });

    it('returns 400 when template has no active version', async () => {
      const draft = makeDraftTemplate({ status: 'disabled', active_version: null });
      repo.findById.mockResolvedValue(draft);

      const token = await signToken({ sub: 'mgr-1', roles: ['marketing_staff', 'marketing_manager'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/enable',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Template has no active version');
    });

    it('returns 400 when template is not disabled', async () => {
      const active = makeDraftTemplate({ status: 'active', active_version: 1 });
      repo.findById.mockResolvedValue(active);

      const token = await signToken({ sub: 'mgr-1', roles: ['marketing_staff', 'marketing_manager'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/enable',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Template is not disabled');
    });

    it('returns 403 when called with marketing_staff role', async () => {
      const token = await signToken({ sub: 'staff-1', roles: ['marketing_staff'] });
      const res = await app.inject({
        method: 'POST',
        url: '/templates/tpl-1/enable',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
