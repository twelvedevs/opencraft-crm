import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionRepository } from '../../src/repositories/execution.repository.js';
import type { Knex } from 'knex';

// Helpers to build chainable Knex query builder mocks
const makeQueryBuilder = (overrides: Record<string, unknown> = {}) => {
  const qb: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    where: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    update: vi.fn().mockResolvedValue(1),
    first: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return qb;
};

const makeDb = (qb: Record<string, unknown>): Knex => {
  const db = vi.fn().mockReturnValue(qb) as unknown as Knex;
  (db as unknown as Record<string, unknown>)['fn'] = { now: vi.fn().mockReturnValue('NOW()') };
  return db;
};

describe('ExecutionRepository', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('insertExecution', () => {
    it('inserts with status=running and started_at, returns inserted row', async () => {
      const insertedRow = {
        id: 'exec-1',
        rule_id: 'rule-1',
        rule_version: 1,
        action_tree_snapshot: '{}',
        event_id: 'evt-1',
        event_type: 'lead.created',
        entity_type: null,
        entity_id: null,
        status: 'running',
        started_at: new Date(),
        completed_at: null,
      };
      const qb = makeQueryBuilder({
        returning: vi.fn().mockResolvedValue([insertedRow]),
      });
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      const result = await repo.insertExecution({
        id: 'exec-1',
        rule_id: 'rule-1',
        rule_version: 1,
        action_tree_snapshot: {},
        event_id: 'evt-1',
        event_type: 'lead.created',
      });

      expect(qb.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'exec-1',
          status: 'running',
          started_at: 'NOW()',
        }),
      );
      expect(result).toEqual(insertedRow);
    });

    it('uses provided status if given', async () => {
      const qb = makeQueryBuilder({ returning: vi.fn().mockResolvedValue([{ id: 'exec-2', status: 'paused' }]) });
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      await repo.insertExecution({
        id: 'exec-2',
        rule_id: 'r',
        rule_version: 1,
        action_tree_snapshot: {},
        event_id: 'e',
        event_type: 't',
        status: 'paused',
      });

      expect(qb.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'paused' }));
    });
  });

  describe('findExecution', () => {
    it('returns execution when found', async () => {
      const row = { id: 'exec-1', event_id: 'evt-1', rule_id: 'rule-1' };
      const qb = makeQueryBuilder({ first: vi.fn().mockResolvedValue(row) });
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      const result = await repo.findExecution('evt-1', 'rule-1');

      expect(qb.where).toHaveBeenCalledWith({ event_id: 'evt-1', rule_id: 'rule-1' });
      expect(result).toEqual(row);
    });

    it('returns null when not found', async () => {
      const qb = makeQueryBuilder({ first: vi.fn().mockResolvedValue(undefined) });
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      const result = await repo.findExecution('evt-x', 'rule-x');

      expect(result).toBeNull();
    });
  });

  describe('updateExecutionStatus', () => {
    it('updates status and completed_at when provided', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);
      const completedAt = new Date('2026-01-01');

      await repo.updateExecutionStatus('exec-1', 'completed', completedAt);

      expect(qb.where).toHaveBeenCalledWith({ id: 'exec-1' });
      expect(qb.update).toHaveBeenCalledWith({ status: 'completed', completed_at: completedAt });
    });

    it('updates only status when completedAt not provided', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      await repo.updateExecutionStatus('exec-1', 'failed');

      expect(qb.update).toHaveBeenCalledWith({ status: 'failed' });
    });
  });

  describe('insertSteps', () => {
    it('bulk inserts steps with status=pending and attempt=0', async () => {
      const qb = makeQueryBuilder({ insert: vi.fn().mockResolvedValue([]) });
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      await repo.insertSteps([
        { id: 's1', execution_id: 'exec-1', action_type: 'send_message', action_params: { to: '+1' } },
        { id: 's2', execution_id: 'exec-1', action_type: 'emit_event' },
      ]);

      expect(qb.insert).toHaveBeenCalledWith([
        expect.objectContaining({ id: 's1', status: 'pending', attempt: 0 }),
        expect.objectContaining({ id: 's2', status: 'pending', attempt: 0 }),
      ]);
    });

    it('does NOT touch DB when steps array is empty', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      await repo.insertSteps([]);

      expect(db).not.toHaveBeenCalled();
    });
  });

  describe('updateStepStatus', () => {
    it('includes all extras columns when all provided', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);
      const startedAt = new Date('2026-01-01T10:00:00Z');
      const completedAt = new Date('2026-01-01T10:01:00Z');

      await repo.updateStepStatus('step-1', 'completed', {
        error: 'some error',
        output: { result: 'ok' },
        attempt: 3,
        startedAt,
        completedAt,
      });

      expect(qb.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
          error: 'some error',
          attempt: 3,
          started_at: startedAt,
          completed_at: completedAt,
        }),
      );
    });

    it('omits extras keys whose value is undefined', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      await repo.updateStepStatus('step-1', 'running', { attempt: 1 });

      const updateArg = (qb.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(updateArg)).not.toContain('error');
      expect(Object.keys(updateArg)).not.toContain('completed_at');
      expect(updateArg['attempt']).toBe(1);
    });
  });

  describe('updateManyStepsStatus', () => {
    it('calls whereIn + update for non-empty IDs', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      await repo.updateManyStepsStatus(['s1', 's2', 's3'], 'skipped');

      expect(qb.whereIn).toHaveBeenCalledWith('id', ['s1', 's2', 's3']);
      expect(qb.update).toHaveBeenCalledWith({ status: 'skipped' });
    });

    it('does NOT touch DB when stepIds array is empty', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      await repo.updateManyStepsStatus([], 'skipped');

      expect(db).not.toHaveBeenCalled();
    });
  });

  describe('findStepById', () => {
    it('returns step when found', async () => {
      const step = { id: 'step-1', execution_id: 'exec-1', action_type: 'emit_event' };
      const qb = makeQueryBuilder({ first: vi.fn().mockResolvedValue(step) });
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      const result = await repo.findStepById('step-1');

      expect(qb.where).toHaveBeenCalledWith({ id: 'step-1' });
      expect(result).toEqual(step);
    });

    it('returns null when not found', async () => {
      const qb = makeQueryBuilder({ first: vi.fn().mockResolvedValue(undefined) });
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      const result = await repo.findStepById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('listExecutions', () => {
    const execRow = {
      id: 'exec-1',
      rule_id: 'rule-1',
      rule_version: 1,
      action_tree_snapshot: '{}',
      event_id: 'evt-1',
      event_type: 'lead.created',
      entity_type: null,
      entity_id: null,
      status: 'completed',
      started_at: new Date('2026-01-01'),
      completed_at: new Date('2026-01-01'),
    };
    const stepRow = {
      id: 'step-1',
      execution_id: 'exec-1',
      action_type: 'send_message',
      action_params: '{}',
      output: null,
      status: 'completed',
      attempt: 1,
      error: null,
      started_at: new Date('2026-01-01'),
      completed_at: new Date('2026-01-01'),
    };

    const makeListDb = (executions: unknown[], steps: unknown[]) => {
      // db is called once for executions (returns executions), once for steps (returns steps)
      let callCount = 0;
      const execQb = {
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        then: undefined as unknown,
      };
      // Make execQb thenable so await works (promise-like)
      Object.defineProperty(execQb, 'then', {
        get() {
          return (resolve: (v: unknown) => void) => resolve(executions);
        },
      });

      const stepQb = {
        whereIn: vi.fn().mockResolvedValue(steps),
      };

      const db = vi.fn().mockImplementation(() => {
        callCount += 1;
        return callCount === 1 ? execQb : stepQb;
      }) as unknown as Knex;
      (db as unknown as Record<string, unknown>)['fn'] = { now: vi.fn().mockReturnValue('NOW()') };

      return { db, execQb, stepQb };
    };

    it('returns all rows with steps embedded when no filters', async () => {
      const { db, stepQb } = makeListDb([execRow], [stepRow]);
      const repo = new ExecutionRepository(db);

      const result = await repo.listExecutions({}, { page: 1, limit: 20 });

      expect(stepQb.whereIn).toHaveBeenCalledWith('execution_id', ['exec-1']);
      expect(result).toHaveLength(1);
      expect(result[0]?.steps).toHaveLength(1);
      expect(result[0]?.steps[0]?.id).toBe('step-1');
    });

    it('applies rule_id WHERE clause', async () => {
      const { db, execQb } = makeListDb([execRow], [stepRow]);
      const repo = new ExecutionRepository(db);

      await repo.listExecutions({ rule_id: 'rule-1' }, { page: 1, limit: 20 });

      expect(execQb.where).toHaveBeenCalledWith('rule_id', 'rule-1');
    });

    it('applies entity_id WHERE clause', async () => {
      const { db, execQb } = makeListDb([execRow], [stepRow]);
      const repo = new ExecutionRepository(db);

      await repo.listExecutions({ entity_id: 'lead-42' }, { page: 1, limit: 20 });

      expect(execQb.where).toHaveBeenCalledWith('entity_id', 'lead-42');
    });

    it('applies status WHERE clause', async () => {
      const { db, execQb } = makeListDb([execRow], [stepRow]);
      const repo = new ExecutionRepository(db);

      await repo.listExecutions({ status: 'completed' }, { page: 1, limit: 20 });

      expect(execQb.where).toHaveBeenCalledWith('status', 'completed');
    });

    it('applies from WHERE clause', async () => {
      const from = new Date('2026-01-01');
      const { db, execQb } = makeListDb([execRow], [stepRow]);
      const repo = new ExecutionRepository(db);

      await repo.listExecutions({ from }, { page: 1, limit: 20 });

      expect(execQb.where).toHaveBeenCalledWith('started_at', '>=', from);
    });

    it('applies to WHERE clause', async () => {
      const to = new Date('2026-12-31');
      const { db, execQb } = makeListDb([execRow], [stepRow]);
      const repo = new ExecutionRepository(db);

      await repo.listExecutions({ to }, { page: 1, limit: 20 });

      expect(execQb.where).toHaveBeenCalledWith('started_at', '<=', to);
    });

    it('applies LIMIT and OFFSET from pagination', async () => {
      const { db, execQb } = makeListDb([execRow], [stepRow]);
      const repo = new ExecutionRepository(db);

      await repo.listExecutions({}, { page: 3, limit: 10 });

      expect(execQb.limit).toHaveBeenCalledWith(10);
      expect(execQb.offset).toHaveBeenCalledWith(20); // (3-1)*10
    });

    it('returns empty array and skips steps query when no executions found', async () => {
      const { db, stepQb } = makeListDb([], []);
      const repo = new ExecutionRepository(db);

      const result = await repo.listExecutions({}, { page: 1, limit: 20 });

      expect(result).toEqual([]);
      expect(stepQb.whereIn).not.toHaveBeenCalled();
    });

    it('embeds empty steps array when execution has no steps', async () => {
      const { db } = makeListDb([execRow], []);
      const repo = new ExecutionRepository(db);

      const result = await repo.listExecutions({}, { page: 1, limit: 20 });

      expect(result[0]?.steps).toEqual([]);
    });
  });

  describe('findStepOutput', () => {
    it('returns output when execution_id and stepId match', async () => {
      const step = { id: 'step-1', execution_id: 'exec-1', output: { draft: 'Hello' } };
      const qb = makeQueryBuilder({ first: vi.fn().mockResolvedValue(step) });
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      const result = await repo.findStepOutput('exec-1', 'step-1');

      expect(qb.where).toHaveBeenCalledWith({ id: 'step-1', execution_id: 'exec-1' });
      expect(result).toEqual({ output: { draft: 'Hello' } });
    });

    it('returns null when stepId not found', async () => {
      const qb = makeQueryBuilder({ first: vi.fn().mockResolvedValue(undefined) });
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      const result = await repo.findStepOutput('exec-1', 'nonexistent-step');

      expect(result).toBeNull();
    });

    it('returns null when execution_id does not match', async () => {
      const qb = makeQueryBuilder({ first: vi.fn().mockResolvedValue(undefined) });
      const db = makeDb(qb);
      const repo = new ExecutionRepository(db);

      const result = await repo.findStepOutput('wrong-exec', 'step-1');

      expect(result).toBeNull();
    });
  });

  describe('deleteExecutionsBefore', () => {
    it('deletes steps first then executions and returns count', async () => {
      const cutoff = new Date('2026-01-01');
      const subQb = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
      };
      const stepsQb = {
        whereIn: vi.fn().mockReturnThis(),
        delete: vi.fn().mockResolvedValue(5),
      };
      const execQb = {
        where: vi.fn().mockReturnThis(),
        delete: vi.fn().mockResolvedValue(2),
      };

      let callCount = 0;
      const db = vi.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) return subQb; // subquery for execution IDs
        if (callCount === 2) return stepsQb; // delete steps
        return execQb; // delete executions
      }) as unknown as Knex;
      (db as unknown as Record<string, unknown>)['fn'] = { now: vi.fn().mockReturnValue('NOW()') };

      const repo = new ExecutionRepository(db);
      const result = await repo.deleteExecutionsBefore(cutoff);

      expect(stepsQb.delete).toHaveBeenCalled();
      expect(execQb.delete).toHaveBeenCalled();
      expect(result).toBe(2);
    });

    it('deletes steps before executions (steps delete is called first)', async () => {
      const cutoff = new Date('2026-01-01');
      const callOrder: string[] = [];

      const subQb = { select: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis() };
      const stepsQb = {
        whereIn: vi.fn().mockReturnThis(),
        delete: vi.fn().mockImplementation(() => { callOrder.push('steps'); return Promise.resolve(0); }),
      };
      const execQb = {
        where: vi.fn().mockReturnThis(),
        delete: vi.fn().mockImplementation(() => { callOrder.push('executions'); return Promise.resolve(0); }),
      };

      let callCount = 0;
      const db = vi.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) return subQb;
        if (callCount === 2) return stepsQb;
        return execQb;
      }) as unknown as Knex;
      (db as unknown as Record<string, unknown>)['fn'] = { now: vi.fn().mockReturnValue('NOW()') };

      const repo = new ExecutionRepository(db);
      await repo.deleteExecutionsBefore(cutoff);

      expect(callOrder).toEqual(['steps', 'executions']);
    });
  });
});
