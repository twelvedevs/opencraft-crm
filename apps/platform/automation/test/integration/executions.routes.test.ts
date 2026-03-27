import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// Mock ExecutionRepository before importing the route plugin
const mockListExecutions = vi.fn();
const mockFindStepOutput = vi.fn();

vi.mock('../../src/repositories/execution.repository.js', () => ({
  ExecutionRepository: vi.fn().mockImplementation(() => ({
    listExecutions: mockListExecutions,
    findStepOutput: mockFindStepOutput,
  })),
}));

// Import after mock setup
const { default: executionRoutes } = await import('../../src/routes/executions.js');

const makeApp = async () => {
  const fastify = Fastify({ logger: false });
  await fastify.register(executionRoutes, { db: {} as never });
  return fastify;
};

const makeExecution = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  rule_id: 'rule-1',
  rule_version: 1,
  action_tree_snapshot: {},
  event_id: `evt-${id}`,
  event_type: 'lead.created',
  entity_type: null,
  entity_id: null,
  status: 'completed',
  started_at: new Date('2026-01-01T00:00:00Z'),
  completed_at: new Date('2026-01-01T00:00:01Z'),
  steps: [],
  ...overrides,
});

describe('GET /executions', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await makeApp();
  });

  it('returns all executions with steps when no filters supplied', async () => {
    const executions = [makeExecution('exec-1'), makeExecution('exec-2')];
    mockListExecutions.mockResolvedValue(executions);

    const res = await app.inject({ method: 'GET', url: '/executions' });

    expect(res.statusCode).toBe(200);
    const body = res.json<unknown[]>();
    expect(body).toHaveLength(2);
    expect(mockListExecutions).toHaveBeenCalledWith({}, { page: 1, limit: 20 });
  });

  it('passes rule_id filter to repo', async () => {
    mockListExecutions.mockResolvedValue([makeExecution('exec-1')]);

    const res = await app.inject({ method: 'GET', url: '/executions?rule_id=rule-abc' });

    expect(res.statusCode).toBe(200);
    expect(mockListExecutions).toHaveBeenCalledWith(
      expect.objectContaining({ rule_id: 'rule-abc' }),
      { page: 1, limit: 20 },
    );
  });

  it('passes status filter to repo', async () => {
    mockListExecutions.mockResolvedValue([makeExecution('exec-1', { status: 'failed' })]);

    const res = await app.inject({ method: 'GET', url: '/executions?status=failed' });

    expect(res.statusCode).toBe(200);
    expect(mockListExecutions).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
      { page: 1, limit: 20 },
    );
  });

  it('applies pagination from query params', async () => {
    mockListExecutions.mockResolvedValue([]);

    const res = await app.inject({ method: 'GET', url: '/executions?page=3&limit=10' });

    expect(res.statusCode).toBe(200);
    expect(mockListExecutions).toHaveBeenCalledWith({}, { page: 3, limit: 10 });
  });

  it('converts from/to strings to Date objects', async () => {
    mockListExecutions.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/executions?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z',
    });

    expect(res.statusCode).toBe(200);
    const call = mockListExecutions.mock.calls[0]!;
    const filters = call[0] as { from: Date; to: Date };
    expect(filters.from).toBeInstanceOf(Date);
    expect(filters.to).toBeInstanceOf(Date);
  });

  it('returns steps embedded in execution objects', async () => {
    const step = {
      id: 'step-1',
      execution_id: 'exec-1',
      action_type: 'send_message',
      action_params: { template_id: 't1' },
      output: { message_id: 'm1' },
      status: 'completed',
      attempt: 1,
      error: null,
      started_at: new Date(),
      completed_at: new Date(),
    };
    mockListExecutions.mockResolvedValue([makeExecution('exec-1', { steps: [step] })]);

    const res = await app.inject({ method: 'GET', url: '/executions' });

    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ steps: unknown[] }>>();
    expect(body[0]!.steps).toHaveLength(1);
  });
});

describe('GET /executions/:executionId/steps/:stepId/output', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await makeApp();
  });

  it('returns 404 when step not found', async () => {
    mockFindStepOutput.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/executions/exec-1/steps/step-unknown/output',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('returns stored output for known step', async () => {
    const output = { message_id: 'msg-123', status: 'delivered' };
    mockFindStepOutput.mockResolvedValue({ output });

    const res = await app.inject({
      method: 'GET',
      url: '/executions/exec-1/steps/step-1/output',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ output });
    expect(mockFindStepOutput).toHaveBeenCalledWith('exec-1', 'step-1');
  });
});
