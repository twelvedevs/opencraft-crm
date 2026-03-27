import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// Mock RulesRepository before importing the route plugin
const mockFindById = vi.fn();
const mockFindVersion = vi.fn();

vi.mock('../../src/repositories/rules.repository.js', () => ({
  RulesRepository: vi.fn().mockImplementation(() => ({
    findAll: vi.fn(),
    findById: mockFindById,
    findByIdRaw: vi.fn(),
    findVersion: mockFindVersion,
    createWithVersion: vi.fn(),
    updateWithVersion: vi.fn(),
    activateVersion: vi.fn(),
    updateStatus: vi.fn(),
    softDelete: vi.fn(),
  })),
}));

// Import after mock setup
const { default: rulesRoutes } = await import('../../src/routes/rules.js');

const makeApp = async () => {
  const fastify = Fastify({ logger: false });
  await fastify.register(rulesRoutes, { db: {} as never });
  return fastify;
};

const makeRule = (overrides: Record<string, unknown> = {}) => ({
  id: 'rule-1',
  name: 'Test Rule',
  status: 'draft',
  active_version: null,
  current_version: 1,
  created_by: null,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
  ...overrides,
});

const makeVersion = (overrides: Record<string, unknown> = {}) => ({
  id: 'ver-1',
  rule_id: 'rule-1',
  version: 1,
  trigger_event_type: 'lead.created',
  condition: null,
  active_hours: null,
  action_tree: { type: 'send_message', params: { template_id: 'tmpl-1' } },
  created_by: null,
  created_at: new Date('2026-01-01'),
  ...overrides,
});

describe('POST /rules/:id/test', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await makeApp();
  });

  it('returns 404 when rule not found', async () => {
    mockFindById.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/rules/unknown/test',
      payload: { event_type: 'lead.created', payload: {} },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'rule not found' });
  });

  it('returns matches:false when condition does not match', async () => {
    mockFindById.mockResolvedValue(makeRule());
    mockFindVersion.mockResolvedValue(
      makeVersion({
        condition: { field: 'status', op: 'eq', value: 'active' },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/rules/rule-1/test',
      payload: { event_type: 'lead.created', payload: { status: 'inactive' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ matches: false, would_execute: [] });
  });

  it('returns correct action for single action tree when condition matches', async () => {
    mockFindById.mockResolvedValue(makeRule());
    mockFindVersion.mockResolvedValue(
      makeVersion({
        condition: null,
        action_tree: { type: 'send_message', params: { template_id: 'tmpl-1' } },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/rules/rule-1/test',
      payload: { event_type: 'lead.created', payload: {} },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      matches: true,
      would_execute: [{ action_type: 'send_message', action_params: { template_id: 'tmpl-1' } }],
    });
  });

  it('returns only winning branch path entries (branch node excluded)', async () => {
    mockFindById.mockResolvedValue(makeRule());
    mockFindVersion.mockResolvedValue(
      makeVersion({
        condition: null,
        action_tree: {
          type: 'branch',
          condition: { field: 'tier', op: 'eq', value: 'premium' },
          if_true: { type: 'send_message', params: { template_id: 'premium-tmpl' } },
          if_false: { type: 'send_email', params: { subject: 'Standard' } },
        },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/rules/rule-1/test',
      payload: { event_type: 'lead.created', payload: { tier: 'premium' } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ matches: boolean; would_execute: unknown[] }>();
    expect(body.matches).toBe(true);
    // Only the winning branch's action — branch node itself not included
    expect(body.would_execute).toEqual([
      { action_type: 'send_message', action_params: { template_id: 'premium-tmpl' } },
    ]);
  });
});
