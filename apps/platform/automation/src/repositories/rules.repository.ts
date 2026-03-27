import type { Knex } from 'knex';

export interface ActiveRule {
  rule_id: string;
  rule_name: string;
  rule_version: number;
  trigger_event_type: string;
  condition: unknown | null;
  active_hours: unknown | null;
  action_tree: unknown;
}

export interface Rule {
  id: string;
  name: string;
  status: string;
  active_version: number | null;
  current_version: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RuleVersion {
  id: string;
  rule_id: string;
  version: number;
  trigger_event_type: string;
  condition: unknown | null;
  active_hours: unknown | null;
  action_tree: unknown;
  created_by: string | null;
  created_at: Date;
}

export interface CreateRuleInput {
  name: string;
  created_by?: string;
}

export interface CreateRuleWithVersionInput {
  name: string;
  trigger_event_type: string;
  condition?: unknown;
  active_hours?: unknown;
  action_tree: unknown;
  created_by?: string;
}

export interface UpdateRuleInput {
  name?: string;
}

export interface UpdateRuleWithVersionInput {
  name?: string;
  trigger_event_type?: string;
  condition?: unknown;
  active_hours?: unknown;
  action_tree?: unknown;
}

export interface CreateVersionInput {
  rule_id: string;
  version: number;
  trigger_event_type: string;
  condition?: unknown;
  active_hours?: unknown;
  action_tree: unknown;
  created_by?: string;
}

const SCHEMA = 'platform_automation';
const RULES_TABLE = `${SCHEMA}.automation_rules`;
const VERSIONS_TABLE = `${SCHEMA}.automation_rule_versions`;

export class RulesRepository {
  constructor(private readonly db: Knex) {}

  async createWithVersion(data: CreateRuleWithVersionInput): Promise<Rule> {
    return this.db.transaction(async (trx) => {
      const [rule] = await trx(RULES_TABLE)
        .insert({
          name: data.name,
          status: 'draft',
          current_version: 1,
          created_by: data.created_by ?? null,
        })
        .returning('*');

      await trx(VERSIONS_TABLE).insert({
        rule_id: (rule as Rule).id,
        version: 1,
        trigger_event_type: data.trigger_event_type,
        condition: data.condition ?? null,
        active_hours: data.active_hours ?? null,
        action_tree: JSON.stringify(data.action_tree),
        created_by: data.created_by ?? null,
      });

      return rule as Rule;
    });
  }

  async create(data: CreateRuleInput): Promise<Rule> {
    const [row] = await this.db(RULES_TABLE)
      .insert({
        name: data.name,
        status: 'draft',
        current_version: 1,
        created_by: data.created_by ?? null,
      })
      .returning('*');
    return row as Rule;
  }

  async findAll(filters?: { status?: string }): Promise<Rule[]> {
    const query = this.db(RULES_TABLE)
      .whereNot('status', 'deleted')
      .orderBy('created_at', 'desc');

    if (filters?.status) {
      query.where('status', filters.status);
    }

    return query as Promise<Rule[]>;
  }

  async findById(id: string): Promise<Rule | null> {
    const row = await this.db(RULES_TABLE)
      .where({ id })
      .whereNot('status', 'deleted')
      .first();
    return (row as Rule) ?? null;
  }

  async update(id: string, data: Partial<UpdateRuleInput>): Promise<Rule | null> {
    const [row] = await this.db(RULES_TABLE)
      .where({ id })
      .whereNot('status', 'deleted')
      .update({
        ...data,
        updated_at: this.db.fn.now(),
      })
      .returning('*');
    return (row as Rule) ?? null;
  }

  async softDelete(id: string): Promise<boolean> {
    const count = await this.db(RULES_TABLE)
      .where({ id })
      .whereNot('status', 'deleted')
      .update({
        status: 'deleted',
        updated_at: this.db.fn.now(),
      });
    return count > 0;
  }

  async insertVersion(data: CreateVersionInput): Promise<RuleVersion> {
    const [row] = await this.db(VERSIONS_TABLE)
      .insert({
        rule_id: data.rule_id,
        version: data.version,
        trigger_event_type: data.trigger_event_type,
        condition: data.condition ?? null,
        active_hours: data.active_hours ?? null,
        action_tree: JSON.stringify(data.action_tree),
        created_by: data.created_by ?? null,
      })
      .returning('*');
    return row as RuleVersion;
  }

  async findVersion(ruleId: string, version: number): Promise<RuleVersion | null> {
    const row = await this.db(VERSIONS_TABLE)
      .where({ rule_id: ruleId, version })
      .first();
    return (row as RuleVersion) ?? null;
  }

  async activateVersion(ruleId: string, version: number): Promise<Rule | null> {
    const [row] = await this.db(RULES_TABLE)
      .where({ id: ruleId })
      .update({
        active_version: version,
        status: 'active',
        updated_at: this.db.fn.now(),
      })
      .returning('*');
    return (row as Rule) ?? null;
  }

  async findByIdRaw(id: string): Promise<Rule | null> {
    const row = await this.db(RULES_TABLE).where({ id }).first();
    return (row as Rule) ?? null;
  }

  async updateWithVersion(id: string, data: UpdateRuleWithVersionInput): Promise<Rule | null> {
    return this.db.transaction(async (trx) => {
      const rule = await trx(RULES_TABLE).where({ id }).whereNot('status', 'deleted').first() as Rule | undefined;
      if (!rule) return null;

      const prev = await trx(VERSIONS_TABLE)
        .where({ rule_id: id, version: rule.current_version })
        .first() as RuleVersion | undefined;

      const newVersion = rule.current_version + 1;

      await trx(VERSIONS_TABLE).insert({
        rule_id: id,
        version: newVersion,
        trigger_event_type: data.trigger_event_type ?? prev?.trigger_event_type ?? '',
        condition: data.condition !== undefined ? data.condition : (prev?.condition ?? null),
        active_hours: data.active_hours !== undefined ? data.active_hours : (prev?.active_hours ?? null),
        action_tree: JSON.stringify(data.action_tree !== undefined ? data.action_tree : (prev?.action_tree ?? {})),
        created_by: null,
      });

      const updateData: Record<string, unknown> = {
        current_version: newVersion,
        updated_at: trx.fn.now(),
      };
      if (data.name !== undefined) updateData['name'] = data.name;

      const [updated] = await trx(RULES_TABLE)
        .where({ id })
        .update(updateData)
        .returning('*');

      return (updated as Rule) ?? null;
    });
  }

  async findActiveByEventType(eventType: string): Promise<ActiveRule[]> {
    const rows = await this.db(`${RULES_TABLE} as r`)
      .join(`${VERSIONS_TABLE} as rv`, function () {
        this.on('rv.rule_id', '=', 'r.id').andOn('rv.version', '=', 'r.active_version');
      })
      .where('r.status', 'active')
      .where('rv.trigger_event_type', eventType)
      .select(
        'r.id as rule_id',
        'r.name as rule_name',
        'rv.version as rule_version',
        'rv.trigger_event_type',
        'rv.condition',
        'rv.active_hours',
        'rv.action_tree',
      );
    return rows as ActiveRule[];
  }

  async updateStatus(id: string, status: string): Promise<Rule | null> {
    const [row] = await this.db(RULES_TABLE)
      .where({ id })
      .whereNot('status', 'deleted')
      .update({ status, updated_at: this.db.fn.now() })
      .returning('*');
    return (row as Rule) ?? null;
  }
}
