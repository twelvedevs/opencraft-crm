import type { Knex } from 'knex';

const SCHEMA = 'platform_automation';
const EXECUTIONS_TABLE = `${SCHEMA}.automation_executions`;
const STEPS_TABLE = `${SCHEMA}.automation_execution_steps`;

export interface Execution {
  id: string;
  rule_id: string;
  rule_version: number;
  action_tree_snapshot: unknown;
  event_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface Step {
  id: string;
  execution_id: string;
  action_type: string;
  action_params: unknown;
  output: unknown;
  status: string;
  attempt: number;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface InsertExecutionData {
  id: string;
  rule_id: string;
  rule_version: number;
  action_tree_snapshot: unknown;
  event_id: string;
  event_type: string;
  entity_type?: string | null;
  entity_id?: string | null;
  status?: string;
}

export interface InsertStepData {
  id: string;
  execution_id: string;
  action_type: string;
  action_params?: unknown;
}

export class ExecutionRepository {
  constructor(private readonly db: Knex) {}

  async insertExecution(data: InsertExecutionData): Promise<Execution> {
    const [row] = await this.db(EXECUTIONS_TABLE)
      .insert({
        id: data.id,
        rule_id: data.rule_id,
        rule_version: data.rule_version,
        action_tree_snapshot: JSON.stringify(data.action_tree_snapshot),
        event_id: data.event_id,
        event_type: data.event_type,
        entity_type: data.entity_type ?? null,
        entity_id: data.entity_id ?? null,
        status: data.status ?? 'running',
        started_at: this.db.fn.now(),
      })
      .returning('*');
    return row as Execution;
  }

  async findExecution(eventId: string, ruleId: string): Promise<Execution | null> {
    const row = await this.db(EXECUTIONS_TABLE)
      .where({ event_id: eventId, rule_id: ruleId })
      .first();
    return (row as Execution) ?? null;
  }

  async updateExecutionStatus(executionId: string, status: string, completedAt?: Date): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (completedAt !== undefined) {
      update['completed_at'] = completedAt;
    }
    await this.db(EXECUTIONS_TABLE).where({ id: executionId }).update(update);
  }

  async insertSteps(steps: InsertStepData[]): Promise<void> {
    if (steps.length === 0) return;
    const rows = steps.map((s) => ({
      id: s.id,
      execution_id: s.execution_id,
      action_type: s.action_type,
      action_params: JSON.stringify(s.action_params ?? null),
      status: 'pending',
      attempt: 0,
    }));
    await this.db(STEPS_TABLE).insert(rows);
  }

  async updateStepStatus(
    stepId: string,
    status: string,
    extras?: {
      error?: string;
      output?: unknown;
      attempt?: number;
      startedAt?: Date;
      completedAt?: Date;
    },
  ): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (extras?.error !== undefined) update['error'] = extras.error;
    if (extras?.output !== undefined) update['output'] = JSON.stringify(extras.output);
    if (extras?.attempt !== undefined) update['attempt'] = extras.attempt;
    if (extras?.startedAt !== undefined) update['started_at'] = extras.startedAt;
    if (extras?.completedAt !== undefined) update['completed_at'] = extras.completedAt;
    await this.db(STEPS_TABLE).where({ id: stepId }).update(update);
  }

  async updateManyStepsStatus(stepIds: string[], status: string): Promise<void> {
    if (stepIds.length === 0) return;
    await this.db(STEPS_TABLE).whereIn('id', stepIds).update({ status });
  }

  async findStepById(stepId: string): Promise<Step | null> {
    const row = await this.db(STEPS_TABLE).where({ id: stepId }).first();
    return (row as Step) ?? null;
  }
}
