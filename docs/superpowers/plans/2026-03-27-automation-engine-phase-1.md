# Automation Engine — Phase 1: Schema & Rule Management API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the Automation Engine service with PostgreSQL schema, migrations, and a full REST API for rule CRUD and versioning.

**Architecture:** Fastify service in `apps/platform/automation/` with Knex for DB access and @sinclair/typebox for schema & request validation. A pure-function `rule-validator` handles business logic (branch depth cap, required fields). The repository pattern isolates all DB queries. No auth in this phase — to be wired when `@ortho/auth-middleware` is implemented.

**Tech Stack:** Node.js 20 + TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest 1

---

## File Map

```
apps/platform/automation/
├── src/
│   ├── index.ts                                # buildApp() factory + server entry point
│   ├── db.ts                                   # Knex singleton: getDb(), closeDb()
│   ├── types.ts                                # All shared TypeScript interfaces
│   ├── routes/
│   │   └── rules.ts                            # Fastify plugin — all /rules endpoints
│   ├── services/
│   │   └── rule-validator.ts                   # Pure: validateRuleInput, checkBranchDepth
│   └── repositories/
│       └── rules.repository.ts                 # All DB queries for rules + versions
├── migrations/
│   ├── 20260101000001_create_schema.ts         # CREATE SCHEMA platform_automation
│   ├── 20260101000002_create_rules_tables.ts   # automation_rules + automation_rule_versions
│   └── 20260101000003_create_execution_tables.ts # automation_executions + steps
├── test/
│   ├── unit/
│   │   └── rule-validator.test.ts
│   └── integration/
│       ├── helpers.ts                          # setupTestDb, truncateAll, buildApp re-export
│       └── rules-api.test.ts
├── knexfile.ts
├── vitest.config.ts
├── package.json
└── tsconfig.json
```

**Key design choices:**
- Migrations table stored in `public` schema (`platform_automation_migrations`) to avoid chicken-and-egg issue with schema creation.
- All DB queries use schema-qualified table names (`platform_automation.automation_rules`).
- `PUT /rules/:id` updates `name` in-place; any change to definition fields (trigger_event_type, condition, active_hours, action_tree) inserts a new version row and increments `current_version`. `active_version` is never touched by updates.
- Branch nesting cap: depth 1–3 allowed, depth 4 rejected. Root node may be a `branch`.
- Missing `dedup_key` on `send_message`/`send_email` is not a validation error (Q7 answer C).

---

## Task 1: Project Scaffold

**Files:**
- Create: `apps/platform/automation/package.json`
- Create: `apps/platform/automation/tsconfig.json`
- Create: `apps/platform/automation/vitest.config.ts`
- Create: `apps/platform/automation/.env.example`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@platform/automation",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "migrate": "tsx node_modules/knex/bin/cli.js migrate:latest --knexfile knexfile.ts",
    "migrate:rollback": "tsx node_modules/knex/bin/cli.js migrate:rollback --knexfile knexfile.ts"
  },
  "dependencies": {
    "@fastify/sensible": "latest",
    "fastify": "latest",
    "fastify-plugin": "latest",
    "knex": "latest",
    "pg": "latest",
    "uuid": "latest",
    "@sinclair/typebox": "latest"
  },
  "devDependencies": {
    "@types/node": "^22",
    "@types/pg": "latest",
    "@types/uuid": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "^1.3.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
  },
});
```

- [ ] **Step 4: Create .env.example**

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ortho_dev
PORT=3000
NODE_ENV=development
```

- [ ] **Step 5: Install dependencies**

```bash
cd apps/platform/automation && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/platform/automation/package.json apps/platform/automation/tsconfig.json apps/platform/automation/vitest.config.ts apps/platform/automation/.env.example apps/platform/automation/package-lock.json
git commit -m "chore(automation): scaffold service — package.json, tsconfig, vitest"
```

---

## Task 2: DB Client + Knexfile

**Files:**
- Create: `apps/platform/automation/src/db.ts`
- Create: `apps/platform/automation/knexfile.ts`

- [ ] **Step 1: Create src/db.ts**

```typescript
import knex, { type Knex } from 'knex';

let _db: Knex | null = null;

export function getDb(): Knex {
  if (!_db) {
    _db = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL,
    });
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.destroy();
    _db = null;
  }
}
```

- [ ] **Step 2: Create knexfile.ts**

```typescript
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Knex } from 'knex';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: join(__dirname, 'migrations'),
    tableName: 'platform_automation_migrations', // stored in public schema — avoids chicken-and-egg with schema creation
    loadExtensions: ['.ts'],
  },
};

export default config;
```

- [ ] **Step 3: Commit**

```bash
git add apps/platform/automation/src/db.ts apps/platform/automation/knexfile.ts
git commit -m "feat(automation): add Knex DB client and knexfile"
```

---

## Task 3: Migrations

**Files:**
- Create: `apps/platform/automation/migrations/20260101000001_create_schema.ts`
- Create: `apps/platform/automation/migrations/20260101000002_create_rules_tables.ts`
- Create: `apps/platform/automation/migrations/20260101000003_create_execution_tables.ts`

- [ ] **Step 1: Create 20260101000001_create_schema.ts**

```typescript
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform_automation');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP SCHEMA IF EXISTS platform_automation CASCADE');
}
```

- [ ] **Step 2: Create 20260101000002_create_rules_tables.ts**

```typescript
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').createTable('automation_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('name').notNullable();
    t.text('status').notNullable().defaultTo('draft'); // draft|active|disabled|deleted
    t.integer('active_version').nullable();
    t.integer('current_version').notNullable().defaultTo(1);
    t.uuid('created_by').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.withSchema('platform_automation').createTable('automation_rule_versions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('rule_id')
      .notNullable()
      .references('id')
      .inTable('platform_automation.automation_rules')
      .onDelete('CASCADE');
    t.integer('version').notNullable();
    t.text('trigger_event_type').notNullable();
    t.jsonb('condition').nullable();
    t.jsonb('active_hours').nullable();
    t.jsonb('action_tree').notNullable();
    t.uuid('created_by').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['rule_id', 'version']);
  });

  await knex.raw(
    'CREATE INDEX ON platform_automation.automation_rule_versions (trigger_event_type)'
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').dropTableIfExists('automation_rule_versions');
  await knex.schema.withSchema('platform_automation').dropTableIfExists('automation_rules');
}
```

- [ ] **Step 3: Create 20260101000003_create_execution_tables.ts**

```typescript
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').createTable('automation_executions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('rule_id')
      .notNullable()
      .references('id')
      .inTable('platform_automation.automation_rules');
    t.integer('rule_version').notNullable();
    t.jsonb('action_tree_snapshot').notNullable();
    t.text('event_id').notNullable();
    t.text('event_type').notNullable();
    t.text('entity_type').nullable();
    t.text('entity_id').nullable();
    t.text('status').notNullable(); // pending|running|completed|failed
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('completed_at', { useTz: true }).nullable();
    t.unique(['event_id', 'rule_id']);
  });

  await knex.schema.withSchema('platform_automation').createTable('automation_execution_steps', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('execution_id')
      .notNullable()
      .references('id')
      .inTable('platform_automation.automation_executions')
      .onDelete('CASCADE');
    t.text('action_type').notNullable();
    t.jsonb('action_params').nullable();
    t.jsonb('output').nullable();
    t.text('status').notNullable(); // pending|running|completed|failed|skipped
    t.integer('attempt').notNullable().defaultTo(0);
    t.text('error').nullable();
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('completed_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').dropTableIfExists('automation_execution_steps');
  await knex.schema.withSchema('platform_automation').dropTableIfExists('automation_executions');
}
```

- [ ] **Step 4: Run migrations to verify they apply cleanly**

```bash
cd apps/platform/automation
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ortho_test npm run migrate
```

Expected: `Batch 1 run: 3 migrations` (or similar), no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/automation/migrations/
git commit -m "feat(automation): add platform_automation schema and table migrations"
```

---

## Task 4: TypeScript Types

**Files:**
- Create: `apps/platform/automation/src/types.ts`

- [ ] **Step 1: Create src/types.ts**

```typescript
export type RuleStatus = 'draft' | 'active' | 'disabled' | 'deleted';

export type ConditionOp =
  | 'eq' | 'neq'
  | 'in' | 'not_in'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains'
  | 'exists' | 'not_exists'
  | 'AND' | 'OR' | 'NOT';

export interface ConditionNode {
  op: ConditionOp;
  field?: string;
  value?: unknown;
  conditions?: ConditionNode[];
}

export interface ActiveHours {
  start: string;          // HH:MM, 24-hour, time-of-day only — no day-of-week
  end: string;            // HH:MM, 24-hour
  timezone_field: string; // dot-notation path into event payload
}

export interface ActionNode {
  type: string;
  params?: Record<string, unknown>;
  next?: AnyActionNode;
}

export interface BranchNode {
  type: 'branch';
  condition: ConditionNode;
  if_true: AnyActionNode;
  if_false: AnyActionNode;
  next?: AnyActionNode;
}

export type AnyActionNode = ActionNode | BranchNode;

export interface AutomationRule {
  id: string;
  name: string;
  status: RuleStatus;
  active_version: number | null;
  current_version: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AutomationRuleVersion {
  id: string;
  rule_id: string;
  version: number;
  trigger_event_type: string;
  condition: ConditionNode | null;
  active_hours: ActiveHours | null;
  action_tree: AnyActionNode;
  created_by: string | null;
  created_at: Date;
}

/** Shape returned by all /rules API endpoints */
export interface RuleWithCurrentVersion extends AutomationRule {
  current_version_details: AutomationRuleVersion | null;
}

export interface CreateRuleInput {
  name: string;
  trigger_event_type: string;
  condition?: ConditionNode;
  active_hours?: ActiveHours;
  action_tree: AnyActionNode;
  created_by?: string;
}

export interface UpdateRuleInput {
  name?: string;
  trigger_event_type?: string;
  condition?: ConditionNode | null;
  active_hours?: ActiveHours | null;
  action_tree?: AnyActionNode;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/platform/automation/src/types.ts
git commit -m "feat(automation): add shared TypeScript types"
```

---

## Task 5: Rule Validator — Branch Depth (TDD)

**Files:**
- Create: `apps/platform/automation/src/services/rule-validator.ts`
- Create: `apps/platform/automation/test/unit/rule-validator.test.ts`

- [ ] **Step 1: Write failing tests for branch depth**

```typescript
// test/unit/rule-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateRuleInput, ValidationError } from '../../src/services/rule-validator.js';
import type { AnyActionNode, BranchNode, CreateRuleInput } from '../../src/types.js';

const leaf: AnyActionNode = {
  type: 'send_message',
  params: {
    template_id: 'tmpl',
    to_field: 'payload.phone',
    from_field: 'payload.location_number',
    dedup_key: '{{event_id}}-sms',
  },
};

/** Builds a chain of `depth` nested branch nodes, terminating with `leaf` */
function makeBranchTree(depth: number): AnyActionNode {
  if (depth <= 0) return leaf;
  return {
    type: 'branch',
    condition: { field: 'payload.x', op: 'eq', value: true },
    if_true: makeBranchTree(depth - 1),
    if_false: leaf,
  };
}

const baseInput: CreateRuleInput = {
  name: 'Welcome SMS',
  trigger_event_type: 'lead.created',
  action_tree: leaf,
};

describe('branch depth validation', () => {
  it('accepts a leaf action at depth 0', () => {
    expect(() => validateRuleInput(baseInput)).not.toThrow();
  });

  it('accepts root node as a branch (depth 1)', () => {
    expect(() => validateRuleInput({ ...baseInput, action_tree: makeBranchTree(1) })).not.toThrow();
  });

  it('accepts exactly 3 levels of nested branches', () => {
    expect(() => validateRuleInput({ ...baseInput, action_tree: makeBranchTree(3) })).not.toThrow();
  });

  it('rejects 4 levels of nested branches', () => {
    expect(() => validateRuleInput({ ...baseInput, action_tree: makeBranchTree(4) }))
      .toThrow(ValidationError);
    expect(() => validateRuleInput({ ...baseInput, action_tree: makeBranchTree(4) }))
      .toThrow('Branch nesting exceeds maximum depth of 3');
  });

  it('checks depth on the if_false path too', () => {
    const deepOnFalse: AnyActionNode = {
      type: 'branch',
      condition: { field: 'payload.x', op: 'eq', value: true },
      if_true: leaf,
      if_false: makeBranchTree(4), // 4 levels on false path
    };
    expect(() => validateRuleInput({ ...baseInput, action_tree: deepOnFalse }))
      .toThrow(ValidationError);
  });

  it('checks depth through next pointers (next does not increase depth)', () => {
    const tree: AnyActionNode = {
      type: 'send_message',
      params: {},
      next: makeBranchTree(3), // 3 levels in a next chain — still valid
    };
    expect(() => validateRuleInput({ ...baseInput, action_tree: tree })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/platform/automation && npx vitest run test/unit/rule-validator.test.ts
```

Expected: all tests fail with `Cannot find module '../../src/services/rule-validator.js'`.

- [ ] **Step 3: Create src/services/rule-validator.ts with branch depth logic**

```typescript
import type { AnyActionNode, BranchNode, CreateRuleInput } from '../types.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MAX_BRANCH_DEPTH = 3;

export function validateRuleInput(input: CreateRuleInput): void {
  if (!input.name?.trim()) throw new ValidationError('name is required');
  if (!input.trigger_event_type?.trim()) throw new ValidationError('trigger_event_type is required');
  if (!input.action_tree) throw new ValidationError('action_tree is required');
  checkBranchDepth(input.action_tree, 0);
}

export function validateActionTree(tree: AnyActionNode): void {
  checkBranchDepth(tree, 0);
}

function checkBranchDepth(node: AnyActionNode, depth: number): void {
  if (node.type === 'branch') {
    if (depth >= MAX_BRANCH_DEPTH) {
      throw new ValidationError(`Branch nesting exceeds maximum depth of ${MAX_BRANCH_DEPTH}`);
    }
    const branch = node as BranchNode;
    if (!branch.condition) throw new ValidationError('Branch node is missing required field: condition');
    if (!branch.if_true) throw new ValidationError('Branch node is missing required field: if_true');
    if (!branch.if_false) throw new ValidationError('Branch node is missing required field: if_false');
    checkBranchDepth(branch.if_true, depth + 1);
    checkBranchDepth(branch.if_false, depth + 1);
  }
  const withNext = node as { next?: AnyActionNode };
  if (withNext.next) {
    checkBranchDepth(withNext.next, depth); // next does not increase branch depth
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run test/unit/rule-validator.test.ts
```

Expected: all 6 branch depth tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/automation/src/services/rule-validator.ts apps/platform/automation/test/unit/rule-validator.test.ts
git commit -m "feat(automation): add rule validator with branch depth check (TDD)"
```

---

## Task 6: Rule Validator — Required Fields + Branch Fields (TDD)

**Files:**
- Modify: `apps/platform/automation/test/unit/rule-validator.test.ts`
- Modify: `apps/platform/automation/src/services/rule-validator.ts` (already complete — tests should pass as-is)

- [ ] **Step 1: Add required field tests to rule-validator.test.ts**

Append to the existing test file (after the branch depth describe block):

```typescript
describe('required field validation', () => {
  it('rejects empty name', () => {
    expect(() => validateRuleInput({ ...baseInput, name: '' })).toThrow(ValidationError);
    expect(() => validateRuleInput({ ...baseInput, name: '  ' })).toThrow(ValidationError);
  });

  it('rejects empty trigger_event_type', () => {
    expect(() => validateRuleInput({ ...baseInput, trigger_event_type: '' })).toThrow(ValidationError);
  });

  it('rejects null action_tree', () => {
    expect(() => validateRuleInput({ ...baseInput, action_tree: null as any })).toThrow(ValidationError);
  });

  it('rejects branch missing condition', () => {
    const tree: AnyActionNode = {
      type: 'branch',
      condition: null as any,
      if_true: leaf,
      if_false: leaf,
    };
    expect(() => validateRuleInput({ ...baseInput, action_tree: tree })).toThrow(ValidationError);
  });

  it('rejects branch missing if_true', () => {
    const tree: AnyActionNode = {
      type: 'branch',
      condition: { field: 'payload.x', op: 'eq', value: true },
      if_true: null as any,
      if_false: leaf,
    };
    expect(() => validateRuleInput({ ...baseInput, action_tree: tree })).toThrow(ValidationError);
  });

  it('rejects branch missing if_false', () => {
    const tree: AnyActionNode = {
      type: 'branch',
      condition: { field: 'payload.x', op: 'eq', value: true },
      if_true: leaf,
      if_false: null as any,
    };
    expect(() => validateRuleInput({ ...baseInput, action_tree: tree })).toThrow(ValidationError);
  });

  it('accepts send_message without dedup_key (warning only per spec Q7)', () => {
    const noDedup: AnyActionNode = {
      type: 'send_message',
      params: { template_id: 'tmpl', to_field: 'payload.phone', from_field: 'payload.loc' },
    };
    expect(() => validateRuleInput({ ...baseInput, action_tree: noDedup })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run full unit test suite**

```bash
npx vitest run test/unit/rule-validator.test.ts
```

Expected: all 13 tests pass. No implementation changes needed — validator already handles all these cases.

- [ ] **Step 3: Commit**

```bash
git add apps/platform/automation/test/unit/rule-validator.test.ts
git commit -m "test(automation): add required field and branch field unit tests"
```

---

## Task 7: Rules Repository

**Files:**
- Create: `apps/platform/automation/src/repositories/rules.repository.ts`

- [ ] **Step 1: Create src/repositories/rules.repository.ts**

```typescript
import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import type {
  AutomationRuleVersion,
  CreateRuleInput,
  RuleWithCurrentVersion,
  UpdateRuleInput,
} from '../types.js';

export class RulesRepository {
  constructor(private db: Knex) {}

  async listRules(): Promise<RuleWithCurrentVersion[]> {
    const rows = await this.db
      .from('platform_automation.automation_rules as r')
      .leftJoin(
        'platform_automation.automation_rule_versions as v',
        this.db.raw('v.rule_id = r.id AND v.version = r.current_version')
      )
      .whereNot('r.status', 'deleted')
      .orderBy('r.created_at', 'desc')
      .select(
        'r.id', 'r.name', 'r.status', 'r.active_version', 'r.current_version',
        'r.created_by', 'r.created_at', 'r.updated_at',
        'v.id as v_id', 'v.version as v_version', 'v.trigger_event_type',
        'v.condition', 'v.active_hours', 'v.action_tree',
        'v.created_by as v_created_by', 'v.created_at as v_created_at'
      );
    return rows.map(toRuleWithVersion);
  }

  async getRuleById(id: string): Promise<RuleWithCurrentVersion | null> {
    const row = await this.db
      .from('platform_automation.automation_rules as r')
      .leftJoin(
        'platform_automation.automation_rule_versions as v',
        this.db.raw('v.rule_id = r.id AND v.version = r.current_version')
      )
      .where('r.id', id)
      .whereNot('r.status', 'deleted')
      .select(
        'r.id', 'r.name', 'r.status', 'r.active_version', 'r.current_version',
        'r.created_by', 'r.created_at', 'r.updated_at',
        'v.id as v_id', 'v.version as v_version', 'v.trigger_event_type',
        'v.condition', 'v.active_hours', 'v.action_tree',
        'v.created_by as v_created_by', 'v.created_at as v_created_at'
      )
      .first();
    return row ? toRuleWithVersion(row) : null;
  }

  async createRule(input: CreateRuleInput): Promise<RuleWithCurrentVersion> {
    const ruleId = uuidv4();
    const now = new Date();

    await this.db.transaction(async (trx) => {
      await trx('platform_automation.automation_rules').insert({
        id: ruleId,
        name: input.name,
        status: 'draft',
        active_version: null,
        current_version: 1,
        created_by: input.created_by ?? null,
        created_at: now,
        updated_at: now,
      });

      await trx('platform_automation.automation_rule_versions').insert({
        id: uuidv4(),
        rule_id: ruleId,
        version: 1,
        trigger_event_type: input.trigger_event_type,
        condition: input.condition != null ? JSON.stringify(input.condition) : null,
        active_hours: input.active_hours != null ? JSON.stringify(input.active_hours) : null,
        action_tree: JSON.stringify(input.action_tree),
        created_by: input.created_by ?? null,
        created_at: now,
      });
    });

    return (await this.getRuleById(ruleId))!;
  }

  async updateRule(id: string, input: UpdateRuleInput, updatedBy?: string): Promise<RuleWithCurrentVersion | null> {
    const existing = await this.getRuleById(id);
    if (!existing) return null;

    const hasDefinitionChange =
      input.trigger_event_type !== undefined ||
      input.condition !== undefined ||
      input.active_hours !== undefined ||
      input.action_tree !== undefined;

    const now = new Date();

    await this.db.transaction(async (trx) => {
      const ruleUpdates: Record<string, unknown> = { updated_at: now };
      if (input.name !== undefined) ruleUpdates.name = input.name;

      if (hasDefinitionChange) {
        const prev = existing.current_version_details!;
        const newVersion = existing.current_version + 1;
        ruleUpdates.current_version = newVersion;

        await trx('platform_automation.automation_rule_versions').insert({
          id: uuidv4(),
          rule_id: id,
          version: newVersion,
          trigger_event_type: input.trigger_event_type ?? prev.trigger_event_type,
          condition: input.condition !== undefined
            ? (input.condition != null ? JSON.stringify(input.condition) : null)
            : (prev.condition != null ? JSON.stringify(prev.condition) : null),
          active_hours: input.active_hours !== undefined
            ? (input.active_hours != null ? JSON.stringify(input.active_hours) : null)
            : (prev.active_hours != null ? JSON.stringify(prev.active_hours) : null),
          action_tree: JSON.stringify(input.action_tree ?? prev.action_tree),
          created_by: updatedBy ?? null,
          created_at: now,
        });
      }

      await trx('platform_automation.automation_rules').where('id', id).update(ruleUpdates);
    });

    return this.getRuleById(id);
  }

  async activateVersion(ruleId: string, version: number): Promise<RuleWithCurrentVersion | null> {
    const exists = await this.db('platform_automation.automation_rule_versions')
      .where({ rule_id: ruleId, version })
      .first();
    if (!exists) return null;

    const rule = await this.db('platform_automation.automation_rules')
      .where({ id: ruleId })
      .whereNot('status', 'deleted')
      .first();
    if (!rule) return null;

    await this.db('platform_automation.automation_rules')
      .where('id', ruleId)
      .update({ active_version: version, status: 'active', updated_at: new Date() });

    return this.getRuleById(ruleId);
  }

  async disableRule(id: string): Promise<RuleWithCurrentVersion | null> {
    const rule = await this.db('platform_automation.automation_rules')
      .where({ id })
      .whereNot('status', 'deleted')
      .first();
    if (!rule) return null;

    await this.db('platform_automation.automation_rules')
      .where('id', id)
      .update({ status: 'disabled', updated_at: new Date() });

    return this.getRuleById(id);
  }

  async softDeleteRule(id: string): Promise<boolean> {
    const count = await this.db('platform_automation.automation_rules')
      .where({ id })
      .whereNot('status', 'deleted')
      .update({ status: 'deleted', updated_at: new Date() });
    return count > 0;
  }
}

function toRuleWithVersion(row: Record<string, unknown>): RuleWithCurrentVersion {
  const versionDetails: AutomationRuleVersion | null = row.v_id
    ? {
        id: row.v_id as string,
        rule_id: row.id as string,
        version: row.v_version as number,
        trigger_event_type: row.trigger_event_type as string,
        condition: (row.condition as AutomationRuleVersion['condition']) ?? null,
        active_hours: (row.active_hours as AutomationRuleVersion['active_hours']) ?? null,
        action_tree: row.action_tree as AutomationRuleVersion['action_tree'],
        created_by: (row.v_created_by as string) ?? null,
        created_at: row.v_created_at as Date,
      }
    : null;

  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as RuleWithCurrentVersion['status'],
    active_version: (row.active_version as number) ?? null,
    current_version: row.current_version as number,
    created_by: (row.created_by as string) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    current_version_details: versionDetails,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/platform/automation/src/repositories/rules.repository.ts
git commit -m "feat(automation): add rules repository with full CRUD and versioning"
```

---

## Task 8: Fastify App + Route Scaffold + Integration Helpers

**Files:**
- Create: `apps/platform/automation/src/index.ts`
- Create: `apps/platform/automation/src/routes/rules.ts`
- Create: `apps/platform/automation/test/integration/helpers.ts`

- [ ] **Step 1: Create src/routes/rules.ts (empty plugin)**

```typescript
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

export const rulesPlugin: FastifyPluginAsync = async (_fastify) => {
  // routes added in subsequent tasks
};

export default fp(rulesPlugin);
```

- [ ] **Step 2: Create src/index.ts**

```typescript
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { rulesPlugin } from './routes/rules.js';

export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.register(sensible);
  app.register(rulesPlugin, { prefix: '/rules' });
  return app;
}

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) {
  const app = buildApp();
  try {
    await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
```

- [ ] **Step 3: Create test/integration/helpers.ts**

```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../../src/db.js';
import { buildApp } from '../../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function setupTestDb(): Promise<void> {
  const db = getDb();
  await db.migrate.latest({
    directory: path.join(__dirname, '../../migrations'),
    tableName: 'platform_automation_migrations',
    loadExtensions: ['.ts'],
  });
}

export async function truncateAll(): Promise<void> {
  const db = getDb();
  await db.raw(`
    TRUNCATE
      platform_automation.automation_execution_steps,
      platform_automation.automation_executions,
      platform_automation.automation_rule_versions,
      platform_automation.automation_rules
    CASCADE
  `);
}

export { closeDb, buildApp };
```

- [ ] **Step 4: Verify the app builds (TypeScript check)**

```bash
cd apps/platform/automation && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/automation/src/index.ts apps/platform/automation/src/routes/rules.ts apps/platform/automation/test/integration/helpers.ts
git commit -m "feat(automation): add Fastify app factory and integration test helpers"
```

---

## Task 9: GET /rules + GET /rules/:id (TDD)

**Files:**
- Create: `apps/platform/automation/test/integration/rules-api.test.ts`
- Modify: `apps/platform/automation/src/routes/rules.ts`

Prereq: a running Postgres instance. Set `DATABASE_URL` in your environment before running integration tests.

- [ ] **Step 1: Create test/integration/rules-api.test.ts with GET tests**

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setupTestDb, truncateAll, closeDb, buildApp } from './helpers.js';
import type { AnyActionNode } from '../../src/types.js';

const leaf: AnyActionNode = {
  type: 'send_message',
  params: {
    template_id: 'welcome-sms',
    to_field: 'payload.phone',
    from_field: 'payload.location_number',
    dedup_key: '{{event_id}}-sms',
  },
};

const validBody = {
  name: 'Welcome SMS',
  trigger_event_type: 'lead.created',
  action_tree: leaf,
};

let app: FastifyInstance;

beforeAll(async () => {
  await setupTestDb();
  app = buildApp();
  await app.ready();
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

// --- helpers ---
async function createRule(overrides = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/rules',
    payload: { ...validBody, ...overrides },
  });
  return res.json();
}

// ============================================================
describe('GET /rules', () => {
  it('returns 200 with empty array when no rules exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/rules' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns all non-deleted rules ordered newest first', async () => {
    await createRule({ name: 'Rule A' });
    await createRule({ name: 'Rule B' });
    const res = await app.inject({ method: 'GET', url: '/rules' });
    expect(res.statusCode).toBe(200);
    const rules = res.json();
    expect(rules).toHaveLength(2);
    expect(rules[0].name).toBe('Rule B'); // newest first
    expect(rules[0].current_version_details).toBeDefined();
    expect(rules[0].current_version_details.trigger_event_type).toBe('lead.created');
  });

  it('excludes soft-deleted rules', async () => {
    const rule = await createRule();
    await app.inject({ method: 'DELETE', url: `/rules/${rule.id}` });
    const res = await app.inject({ method: 'GET', url: '/rules' });
    expect(res.json()).toHaveLength(0);
  });
});

describe('GET /rules/:id', () => {
  it('returns 200 with rule and version details', async () => {
    const created = await createRule();
    const res = await app.inject({ method: 'GET', url: `/rules/${created.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe('Welcome SMS');
    expect(body.status).toBe('draft');
    expect(body.active_version).toBeNull();
    expect(body.current_version).toBe(1);
    expect(body.current_version_details.action_tree).toEqual(leaf);
  });

  it('returns 404 for non-existent id', async () => {
    const res = await app.inject({ method: 'GET', url: '/rules/00000000-0000-0000-0000-000000000000' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for soft-deleted rule', async () => {
    const rule = await createRule();
    await app.inject({ method: 'DELETE', url: `/rules/${rule.id}` });
    const res = await app.inject({ method: 'GET', url: `/rules/${rule.id}` });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ortho_test npx vitest run test/integration/rules-api.test.ts
```

Expected: tests for GET endpoints fail because routes aren't implemented. The POST used in `createRule()` also fails — that's fine at this stage.

- [ ] **Step 3: Add GET routes to src/routes/rules.ts**

```typescript
import fp from 'fastify-plugin';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { RulesRepository } from '../repositories/rules.repository.js';
import { validateRuleInput, validateActionTree, ValidationError } from '../services/rule-validator.js';
import { getDb } from '../db.js';

const CreateRuleBody = z.object({
  name: z.string().min(1),
  trigger_event_type: z.string().min(1),
  condition: z.record(z.unknown()).optional(),
  active_hours: z.object({
    start: z.string(),
    end: z.string(),
    timezone_field: z.string(),
  }).optional(),
  action_tree: z.record(z.unknown()),
});

const UpdateRuleBody = z.object({
  name: z.string().min(1).optional(),
  trigger_event_type: z.string().min(1).optional(),
  condition: z.record(z.unknown()).nullable().optional(),
  active_hours: z.object({
    start: z.string(),
    end: z.string(),
    timezone_field: z.string(),
  }).nullable().optional(),
  action_tree: z.record(z.unknown()).optional(),
});

export const rulesPlugin: FastifyPluginAsync = async (fastify) => {
  const repo = new RulesRepository(getDb());

  fastify.get('/', async (_req, reply) => {
    return reply.send(await repo.listRules());
  });

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const rule = await repo.getRuleById(req.params.id);
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });
    return reply.send(rule);
  });
};

export default fp(rulesPlugin);
```

- [ ] **Step 4: Run GET tests only (POST tests still expected to fail)**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ortho_test npx vitest run test/integration/rules-api.test.ts -t "GET"
```

Expected: all GET tests pass. (POST tests still failing — that's next task.)

- [ ] **Step 5: Commit**

```bash
git add apps/platform/automation/src/routes/rules.ts apps/platform/automation/test/integration/rules-api.test.ts
git commit -m "feat(automation): add GET /rules and GET /rules/:id (TDD)"
```

---

## Task 10: POST /rules (TDD)

**Files:**
- Modify: `apps/platform/automation/test/integration/rules-api.test.ts`
- Modify: `apps/platform/automation/src/routes/rules.ts`

- [ ] **Step 1: Add POST tests to rules-api.test.ts**

Add after the GET /rules/:id describe block:

```typescript
describe('POST /rules', () => {
  it('creates a draft rule with version 1 and returns 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/rules', payload: validBody });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe('Welcome SMS');
    expect(body.status).toBe('draft');
    expect(body.active_version).toBeNull();
    expect(body.current_version).toBe(1);
    expect(body.current_version_details.trigger_event_type).toBe('lead.created');
    expect(body.current_version_details.version).toBe(1);
    expect(body.current_version_details.action_tree).toEqual(leaf);
  });

  it('accepts optional condition and active_hours', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rules',
      payload: {
        ...validBody,
        condition: { field: 'payload.source', op: 'eq', value: 'google' },
        active_hours: { start: '08:00', end: '20:00', timezone_field: 'payload.location_timezone' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().current_version_details.condition).toEqual({ field: 'payload.source', op: 'eq', value: 'google' });
    expect(res.json().current_version_details.active_hours.start).toBe('08:00');
  });

  it('returns 400 for missing name', async () => {
    const res = await app.inject({
      method: 'POST', url: '/rules',
      payload: { trigger_event_type: 'lead.created', action_tree: leaf },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing action_tree', async () => {
    const res = await app.inject({
      method: 'POST', url: '/rules',
      payload: { name: 'Test', trigger_event_type: 'lead.created' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when branch nesting exceeds 3 levels', async () => {
    const deepTree: AnyActionNode = {
      type: 'branch',
      condition: { field: 'payload.a', op: 'eq', value: 1 },
      if_true: {
        type: 'branch',
        condition: { field: 'payload.b', op: 'eq', value: 1 },
        if_true: {
          type: 'branch',
          condition: { field: 'payload.c', op: 'eq', value: 1 },
          if_true: {
            type: 'branch', // 4th level — invalid
            condition: { field: 'payload.d', op: 'eq', value: 1 },
            if_true: leaf,
            if_false: leaf,
          },
          if_false: leaf,
        },
        if_false: leaf,
      },
      if_false: leaf,
    };
    const res = await app.inject({
      method: 'POST', url: '/rules',
      payload: { ...validBody, action_tree: deepTree },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Branch nesting/);
  });
});
```

- [ ] **Step 2: Run POST tests to confirm they fail**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ortho_test npx vitest run test/integration/rules-api.test.ts -t "POST"
```

Expected: 5 POST tests fail.

- [ ] **Step 3: Add POST /rules route to rules.ts**

Add inside the `rulesPlugin` async function, after the GET routes:

```typescript
  fastify.post('/', async (req, reply) => {
    const parsed = CreateRuleBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.errors });
    }

    try {
      validateRuleInput(parsed.data as any);
    } catch (err) {
      if (err instanceof ValidationError) return reply.status(400).send({ error: err.message });
      throw err;
    }

    const rule = await repo.createRule(parsed.data as any);
    return reply.status(201).send(rule);
  });
```

- [ ] **Step 4: Run all tests to confirm POST passes and GET still passes**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ortho_test npx vitest run test/integration/rules-api.test.ts
```

Expected: all GET and POST tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/automation/src/routes/rules.ts apps/platform/automation/test/integration/rules-api.test.ts
git commit -m "feat(automation): add POST /rules with validation (TDD)"
```

---

## Task 11: PUT /rules/:id — Update + New Version (TDD)

**Files:**
- Modify: `apps/platform/automation/test/integration/rules-api.test.ts`
- Modify: `apps/platform/automation/src/routes/rules.ts`

- [ ] **Step 1: Add PUT /rules/:id tests**

Append to `rules-api.test.ts`:

```typescript
describe('PUT /rules/:id', () => {
  it('updates name only — no new version created', async () => {
    const rule = await createRule();
    const res = await app.inject({
      method: 'PUT', url: `/rules/${rule.id}`,
      payload: { name: 'Renamed Rule' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Renamed Rule');
    expect(res.json().current_version).toBe(1);
  });

  it('updates action_tree — creates version 2, active_version unchanged', async () => {
    const rule = await createRule();
    const newTree: AnyActionNode = {
      type: 'enroll_sequence',
      params: {
        sequence_id: 'seq-1',
        entity_type: 'payload.entity_type',
        entity_id: 'payload.entity_id',
        dedup_key: '{{event_id}}-enroll',
      },
    };
    const res = await app.inject({
      method: 'PUT', url: `/rules/${rule.id}`,
      payload: { action_tree: newTree },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.current_version).toBe(2);
    expect(body.active_version).toBeNull(); // unchanged
    expect(body.current_version_details.action_tree).toEqual(newTree);
  });

  it('updates trigger_event_type — creates new version, inherits other fields', async () => {
    const rule = await createRule({
      condition: { field: 'payload.x', op: 'eq', value: 1 },
    });
    const res = await app.inject({
      method: 'PUT', url: `/rules/${rule.id}`,
      payload: { trigger_event_type: 'lead.stage_changed' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.current_version).toBe(2);
    expect(body.current_version_details.trigger_event_type).toBe('lead.stage_changed');
    expect(body.current_version_details.condition).toEqual({ field: 'payload.x', op: 'eq', value: 1 }); // inherited
  });

  it('returns 400 for invalid action_tree (branch depth exceeded)', async () => {
    const rule = await createRule();
    const tooDeep: AnyActionNode = {
      type: 'branch',
      condition: { field: 'a', op: 'eq', value: 1 },
      if_true: {
        type: 'branch',
        condition: { field: 'b', op: 'eq', value: 1 },
        if_true: {
          type: 'branch',
          condition: { field: 'c', op: 'eq', value: 1 },
          if_true: {
            type: 'branch', // depth 4
            condition: { field: 'd', op: 'eq', value: 1 },
            if_true: leaf,
            if_false: leaf,
          },
          if_false: leaf,
        },
        if_false: leaf,
      },
      if_false: leaf,
    };
    const res = await app.inject({
      method: 'PUT', url: `/rules/${rule.id}`,
      payload: { action_tree: tooDeep },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for non-existent rule', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/rules/00000000-0000-0000-0000-000000000000',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run PUT tests to confirm they fail**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ortho_test npx vitest run test/integration/rules-api.test.ts -t "PUT /rules/:id"
```

Expected: all 5 PUT tests fail (404 — route not registered).

- [ ] **Step 3: Add PUT /rules/:id to rules.ts**

Add inside `rulesPlugin` after the POST route:

```typescript
  fastify.put<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const parsed = UpdateRuleBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.errors });
    }

    if (parsed.data.action_tree) {
      try {
        validateActionTree(parsed.data.action_tree as any);
      } catch (err) {
        if (err instanceof ValidationError) return reply.status(400).send({ error: err.message });
        throw err;
      }
    }

    const rule = await repo.updateRule(req.params.id, parsed.data as any);
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });
    return reply.send(rule);
  });
```

- [ ] **Step 4: Run all tests**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ortho_test npx vitest run test/integration/rules-api.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/automation/src/routes/rules.ts apps/platform/automation/test/integration/rules-api.test.ts
git commit -m "feat(automation): add PUT /rules/:id with version creation (TDD)"
```

---

## Task 12: Activate, Disable, and Delete Routes (TDD)

**Files:**
- Modify: `apps/platform/automation/test/integration/rules-api.test.ts`
- Modify: `apps/platform/automation/src/routes/rules.ts`

- [ ] **Step 1: Add activate, disable, and delete tests**

Append to `rules-api.test.ts`:

```typescript
describe('PUT /rules/:id/versions/:v/activate', () => {
  it('activates version 1 — status becomes active, active_version set', async () => {
    const rule = await createRule();
    const res = await app.inject({ method: 'PUT', url: `/rules/${rule.id}/versions/1/activate` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('active');
    expect(body.active_version).toBe(1);
  });

  it('activates a draft version of an already-active rule — active_version updates, rule stays active', async () => {
    const rule = await createRule();
    await app.inject({ method: 'PUT', url: `/rules/${rule.id}/versions/1/activate` });
    // create version 2
    await app.inject({
      method: 'PUT', url: `/rules/${rule.id}`,
      payload: { trigger_event_type: 'lead.stage_changed' },
    });
    const res = await app.inject({ method: 'PUT', url: `/rules/${rule.id}/versions/2/activate` });
    expect(res.statusCode).toBe(200);
    expect(res.json().active_version).toBe(2);
    expect(res.json().status).toBe('active');
  });

  it('returns 404 for non-existent version', async () => {
    const rule = await createRule();
    const res = await app.inject({ method: 'PUT', url: `/rules/${rule.id}/versions/99/activate` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for non-existent rule', async () => {
    const res = await app.inject({ method: 'PUT', url: '/rules/00000000-0000-0000-0000-000000000000/versions/1/activate' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for non-numeric version param', async () => {
    const rule = await createRule();
    const res = await app.inject({ method: 'PUT', url: `/rules/${rule.id}/versions/abc/activate` });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /rules/:id/disable', () => {
  it('disables a draft rule', async () => {
    const rule = await createRule();
    const res = await app.inject({ method: 'PUT', url: `/rules/${rule.id}/disable` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('disabled');
  });

  it('disables an active rule', async () => {
    const rule = await createRule();
    await app.inject({ method: 'PUT', url: `/rules/${rule.id}/versions/1/activate` });
    const res = await app.inject({ method: 'PUT', url: `/rules/${rule.id}/disable` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('disabled');
    expect(res.json().active_version).toBe(1); // active_version preserved
  });

  it('returns 404 for non-existent rule', async () => {
    const res = await app.inject({ method: 'PUT', url: '/rules/00000000-0000-0000-0000-000000000000/disable' });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /rules/:id', () => {
  it('soft-deletes a rule — returns 204 no body', async () => {
    const rule = await createRule();
    const res = await app.inject({ method: 'DELETE', url: `/rules/${rule.id}` });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('deleted rule no longer appears in list or get', async () => {
    const rule = await createRule();
    await app.inject({ method: 'DELETE', url: `/rules/${rule.id}` });
    const get = await app.inject({ method: 'GET', url: `/rules/${rule.id}` });
    expect(get.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/rules' });
    expect(list.json()).toHaveLength(0);
  });

  it('returns 404 for non-existent rule', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/rules/00000000-0000-0000-0000-000000000000' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when deleting an already-deleted rule', async () => {
    const rule = await createRule();
    await app.inject({ method: 'DELETE', url: `/rules/${rule.id}` });
    const res = await app.inject({ method: 'DELETE', url: `/rules/${rule.id}` });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run new tests to confirm they fail**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ortho_test npx vitest run test/integration/rules-api.test.ts -t "activate|disable|DELETE"
```

Expected: 12 new tests fail (routes not registered).

- [ ] **Step 3: Add activate, disable, and delete routes to rules.ts**

Add inside `rulesPlugin` after the PUT /:id route:

```typescript
  fastify.put<{ Params: { id: string; v: string } }>('/:id/versions/:v/activate', async (req, reply) => {
    const version = parseInt(req.params.v, 10);
    if (isNaN(version)) return reply.status(400).send({ error: 'Version must be a number' });

    const rule = await repo.activateVersion(req.params.id, version);
    if (!rule) return reply.status(404).send({ error: 'Rule or version not found' });
    return reply.send(rule);
  });

  fastify.put<{ Params: { id: string } }>('/:id/disable', async (req, reply) => {
    const rule = await repo.disableRule(req.params.id);
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });
    return reply.send(rule);
  });

  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const deleted = await repo.softDeleteRule(req.params.id);
    if (!deleted) return reply.status(404).send({ error: 'Rule not found' });
    return reply.status(204).send();
  });
```

- [ ] **Step 4: Run full integration test suite**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ortho_test npx vitest run test/integration/rules-api.test.ts
```

Expected: all tests pass. Note count at end — should be 30+ tests.

- [ ] **Step 5: Run unit tests to confirm nothing broken**

```bash
npx vitest run test/unit/
```

Expected: all 13 unit tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/platform/automation/src/routes/rules.ts apps/platform/automation/test/integration/rules-api.test.ts
git commit -m "feat(automation): add activate, disable, and soft-delete routes (TDD)"
```

---

## Self-Review Checklist

Spec section → plan coverage:

| Spec requirement | Task |
|---|---|
| DB schema — all 4 tables | Task 3 |
| `automation_rules`: id, name, status, active_version, current_version, created_by, timestamps | Task 3 |
| `automation_rule_versions`: id, rule_id, version, trigger_event_type, condition, active_hours, action_tree, created_by, created_at, UNIQUE(rule_id, version) | Task 3 |
| `automation_executions` + `automation_execution_steps` tables | Task 3 |
| Index on `trigger_event_type` | Task 3 (step 2, `CREATE INDEX`) |
| Rule CRUD: create, read, update, soft-delete | Tasks 9–12 |
| Rule versioning: new version on edit, active_version unchanged on edit | Tasks 7, 11 |
| Activate version → active_version advances, status = active | Tasks 7, 12 |
| Disable rule | Tasks 7, 12 |
| Soft delete (status = deleted, hidden from list/get) | Tasks 7, 12 |
| Branch nesting hard cap = 3 levels, enforced at save | Tasks 5–6 (unit), Tasks 10–11 (integration) |
| Missing dedup_key: warning only, not a save-time error | Task 6 |
| Rule group (automation_rules) + version history (automation_rule_versions) coexist | Task 7 |
| GET /rules, GET /rules/:id, POST /rules | Tasks 9–10 |
| PUT /rules/:id/versions/:v/activate | Task 12 |
| DELETE /rules/:id | Task 12 |
| Root node may be a branch | Task 5 (test: "accepts root node as a branch") |
