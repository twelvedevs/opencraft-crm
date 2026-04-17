# Location Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a master `locations` table to the identity service with full CRUD API, a gateway proxy, and CLI commands.

**Architecture:** Locations live in `platform_identity.locations`. The identity service owns CRUD routes at `/identity/locations`. The CRM API gateway proxies `/v1/locations` to the identity service. The CLI gets a `crm locations` command group.

**Tech Stack:** Node.js 24, TypeScript 5 (ESM), Fastify 5, `pg` (raw queries), Knex (migrations only), TypeBox, Vitest 2, Commander + Inquirer (CLI).

---

## File Map

| Action | Path |
|---|---|
| CREATE | `apps/platform/identity/migrations/003_create_locations.ts` |
| CREATE | `apps/platform/identity/src/repositories/location.repo.ts` |
| CREATE | `apps/platform/identity/src/routes/locations.ts` |
| MODIFY | `apps/platform/identity/src/app.ts` |
| MODIFY | `apps/platform/identity/test/integration/helpers.ts` |
| CREATE | `apps/platform/identity/test/unit/location.repo.test.ts` |
| CREATE | `apps/platform/identity/test/integration/locations.test.ts` |
| CREATE | `apps/crm/api-gateway/src/routes/locations.ts` |
| MODIFY | `apps/crm/api-gateway/src/index.ts` |
| CREATE | `tools/crm-cli/src/commands/locations.ts` |
| MODIFY | `tools/crm-cli/src/index.ts` |

---

## Task 1: Migration — create locations table and add FK

**Files:**
- Create: `apps/platform/identity/migrations/003_create_locations.ts`

This migration creates the `platform_identity.locations` master table and adds a FK from `user_locations.location_id` to it. All commands run from `apps/platform/identity/`.

- [ ] **Step 1: Write the migration**

Create `apps/platform/identity/migrations/003_create_locations.ts`:

```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_identity').createTable('locations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.varchar('name').notNullable();
    table.varchar('phone').notNullable();
    table.varchar('address').notNullable();
    table.varchar('timezone').notNullable();
    table.varchar('status').notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE platform_identity.locations
    ADD CONSTRAINT locations_status_check
    CHECK (status IN ('active','inactive'))
  `);

  await knex.raw('CREATE INDEX locations_status_idx ON platform_identity.locations (status)');
  await knex.raw('CREATE INDEX locations_name_idx ON platform_identity.locations (name)');

  await knex.raw(`
    ALTER TABLE platform_identity.user_locations
    ADD CONSTRAINT user_locations_location_id_fkey
    FOREIGN KEY (location_id) REFERENCES platform_identity.locations(id) ON DELETE RESTRICT
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE platform_identity.user_locations
    DROP CONSTRAINT IF EXISTS user_locations_location_id_fkey
  `);
  await knex.schema.withSchema('platform_identity').dropTableIfExists('locations');
}
```

- [ ] **Step 2: Commit**

```bash
cd apps/platform/identity
git add migrations/003_create_locations.ts
git commit -m "feat(identity): add locations migration"
```

---

## Task 2: Location repository

**Files:**
- Create: `apps/platform/identity/src/repositories/location.repo.ts`
- Create: `apps/platform/identity/test/unit/location.repo.test.ts`

The repository uses raw `pg` (same pattern as `user.repo.ts`). No Knex in app code.

- [ ] **Step 1: Write the failing unit tests**

Create `apps/platform/identity/test/unit/location.repo.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

function makePool(rows: unknown[] = []): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

// Dynamic import after vi.mock calls
let repo: typeof import('../../src/repositories/location.repo.js');

beforeEach(async () => {
  vi.resetModules();
  repo = await import('../../src/repositories/location.repo.js');
});

describe('location.repo', () => {
  describe('findAll', () => {
    it('returns all rows when no status filter', async () => {
      const row = { id: 'uuid-1', name: 'A', phone: '+1', address: '1 St', timezone: 'UTC', status: 'active' };
      const pool = makePool([row]);
      const result = await repo.findAll(pool);
      expect(result).toEqual([row]);
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]?];
      expect(call[0]).toContain('FROM platform_identity.locations');
      expect(call[1]).toEqual([]);
    });

    it('appends WHERE clause when status filter provided', async () => {
      const pool = makePool([]);
      await repo.findAll(pool, 'active');
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]?];
      expect(call[0]).toContain('WHERE status =');
      expect(call[1]).toEqual(['active']);
    });
  });

  describe('findById', () => {
    it('returns row when found', async () => {
      const row = { id: 'uuid-1', name: 'A' };
      const pool = makePool([row]);
      const result = await repo.findById(pool, 'uuid-1');
      expect(result).toEqual(row);
    });

    it('returns null when not found', async () => {
      const pool = makePool([]);
      const result = await repo.findById(pool, 'missing');
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('inserts and returns the new row', async () => {
      const row = { id: 'uuid-new', name: 'B', phone: '+2', address: '2 St', timezone: 'UTC', status: 'active' };
      const pool = makePool([row]);
      const result = await repo.create(pool, { name: 'B', phone: '+2', address: '2 St', timezone: 'UTC' });
      expect(result).toEqual(row);
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]?];
      expect(call[0]).toContain('INSERT INTO platform_identity.locations');
    });
  });

  describe('update', () => {
    it('returns updated row when found', async () => {
      const row = { id: 'uuid-1', name: 'New Name' };
      const pool = makePool([row]);
      const result = await repo.update(pool, 'uuid-1', { name: 'New Name' });
      expect(result).toEqual(row);
    });

    it('returns null when not found', async () => {
      const pool = makePool([]);
      const result = await repo.update(pool, 'missing', { name: 'X' });
      expect(result).toBeNull();
    });
  });

  describe('softDelete', () => {
    it('returns true when row found and updated', async () => {
      const pool = makePool([{ id: 'uuid-1' }]);
      const result = await repo.softDelete(pool, 'uuid-1');
      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      const pool = makePool([]);
      const result = await repo.softDelete(pool, 'missing');
      expect(result).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (module not found)**

```bash
cd apps/platform/identity
npx vitest run test/unit/location.repo.test.ts
```

Expected: FAIL — `Cannot find module '../../src/repositories/location.repo.js'`

- [ ] **Step 3: Implement the repository**

Create `apps/platform/identity/src/repositories/location.repo.ts`:

```ts
import type { Pool } from 'pg';

export type Location = {
  id: string;
  name: string;
  phone: string;
  address: string;
  timezone: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
};

export async function findAll(pool: Pool, status?: string): Promise<Location[]> {
  const values: unknown[] = [];
  let sql = 'SELECT * FROM platform_identity.locations';
  if (status !== undefined) {
    values.push(status);
    sql += ' WHERE status = $1';
  }
  sql += ' ORDER BY name';
  const result = await pool.query(sql, values);
  return result.rows;
}

export async function findById(pool: Pool, id: string): Promise<Location | null> {
  const result = await pool.query(
    'SELECT * FROM platform_identity.locations WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

export async function create(
  pool: Pool,
  data: { name: string; phone: string; address: string; timezone: string },
): Promise<Location> {
  const result = await pool.query(
    `INSERT INTO platform_identity.locations (name, phone, address, timezone)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.name, data.phone, data.address, data.timezone],
  );
  return result.rows[0];
}

export async function update(
  pool: Pool,
  id: string,
  data: Partial<{ name: string; phone: string; address: string; timezone: string; status: string }>,
): Promise<Location | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (data.name !== undefined) { fields.push(`name = $${paramIdx++}`); values.push(data.name); }
  if (data.phone !== undefined) { fields.push(`phone = $${paramIdx++}`); values.push(data.phone); }
  if (data.address !== undefined) { fields.push(`address = $${paramIdx++}`); values.push(data.address); }
  if (data.timezone !== undefined) { fields.push(`timezone = $${paramIdx++}`); values.push(data.timezone); }
  if (data.status !== undefined) { fields.push(`status = $${paramIdx++}`); values.push(data.status); }

  if (fields.length === 0) return findById(pool, id);

  fields.push(`updated_at = now()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE platform_identity.locations SET ${fields.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function softDelete(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE platform_identity.locations SET status = 'inactive', updated_at = now() WHERE id = $1 RETURNING id`,
    [id],
  );
  return result.rows.length > 0;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd apps/platform/identity
npx vitest run test/unit/location.repo.test.ts
```

Expected: all 8 tests PASS

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/repositories/location.repo.ts test/unit/location.repo.test.ts
git commit -m "feat(identity): add location repository with unit tests"
```

---

## Task 3: Location routes

**Files:**
- Create: `apps/platform/identity/src/routes/locations.ts`

- [ ] **Step 1: Create the routes file**

Create `apps/platform/identity/src/routes/locations.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Pool } from 'pg';
import { requireRole } from '@ortho/auth-middleware';
import * as locationRepo from '../repositories/location.repo.js';

const superAdminOnly = requireRole(['super_admin']);

const IdParams = Type.Object({ id: Type.String() });

const CreateLocationBody = Type.Object({
  name: Type.String(),
  phone: Type.String(),
  address: Type.String(),
  timezone: Type.String(),
});

const PatchLocationBody = Type.Object({
  name: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  address: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
});

const ListLocationsQuery = Type.Object({
  status: Type.Optional(Type.String()),
});

export async function locationsRoutes(app: FastifyInstance, opts: { pool: Pool }): Promise<void> {
  const { pool } = opts;

  // GET /identity/locations
  app.get('/identity/locations', {
    schema: { querystring: ListLocationsQuery, tags: ['Locations'], summary: 'List locations' } as object,
  }, async (req, reply) => {
    const { status } = req.query as { status?: string };
    const locations = await locationRepo.findAll(pool, status);
    return reply.status(200).send({ locations });
  });

  // GET /identity/locations/:id
  app.get('/identity/locations/:id', {
    schema: { params: IdParams, tags: ['Locations'], summary: 'Get location by ID' } as object,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const location = await locationRepo.findById(pool, id);
    if (!location) return reply.status(404).send({ error: 'not_found' });
    return reply.status(200).send(location);
  });

  // POST /identity/locations
  app.post('/identity/locations', {
    schema: { body: CreateLocationBody, tags: ['Locations'], summary: 'Create location' } as object,
    preHandler: [superAdminOnly],
  }, async (req, reply) => {
    const body = req.body as { name: string; phone: string; address: string; timezone: string };
    const location = await locationRepo.create(pool, body);
    return reply.status(201).send(location);
  });

  // PATCH /identity/locations/:id
  app.patch('/identity/locations/:id', {
    schema: { params: IdParams, body: PatchLocationBody, tags: ['Locations'], summary: 'Update location' } as object,
    preHandler: [superAdminOnly],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<{ name: string; phone: string; address: string; timezone: string; status: string }>;
    const location = await locationRepo.update(pool, id, body);
    if (!location) return reply.status(404).send({ error: 'not_found' });
    return reply.status(200).send(location);
  });

  // DELETE /identity/locations/:id — soft delete (sets status=inactive)
  app.delete('/identity/locations/:id', {
    schema: { params: IdParams, tags: ['Locations'], summary: 'Deactivate location (soft delete)' } as object,
    preHandler: [superAdminOnly],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    let found: boolean;
    try {
      found = await locationRepo.softDelete(pool, id);
    } catch (err: unknown) {
      // FK violation: location has users assigned
      const error = err as { code?: string };
      if (error.code === '23503') {
        return reply.status(409).send({ error: 'location_has_users' });
      }
      throw err;
    }
    if (!found) return reply.status(404).send({ error: 'not_found' });
    return reply.status(204).send();
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/platform/identity
npm run typecheck
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/routes/locations.ts
git commit -m "feat(identity): add location CRUD routes"
```

---

## Task 4: Register routes in app.ts + add OpenAPI tag

**Files:**
- Modify: `apps/platform/identity/src/app.ts`

- [ ] **Step 1: Register the locations routes and add OpenAPI tag**

In `apps/platform/identity/src/app.ts`, make two edits:

**Add `'Locations'` to the OpenAPI tags array** (after `'API Keys'`):
```ts
      { name: 'API Keys', description: 'Service API key management' },
      { name: 'Locations', description: 'Practice location management' },
      { name: 'JWKS', description: 'Public key set for JWT verification' },
```

**Add the import** (after the `apiKeysRoutes` import):
```ts
import { locationsRoutes } from './routes/locations.js';
```

**Register the routes** (after `await app.register(apiKeysRoutes, { pool })`):
```ts
  await app.register(locationsRoutes, { pool });
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/platform/identity
npm run typecheck
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/app.ts
git commit -m "feat(identity): register location routes in app"
```

---

## Task 5: Update integration test helpers

**Files:**
- Modify: `apps/platform/identity/test/integration/helpers.ts`

The integration test helpers create the schema from raw SQL (not migrations). Add the `locations` table and update truncation order.

- [ ] **Step 1: Add locations table to `createSchema`**

In `apps/platform/identity/test/integration/helpers.ts`, inside `createSchema`, add the locations table **before** the `user_locations` table (FK dependency order):

```ts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_identity.locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar NOT NULL,
      phone varchar NOT NULL,
      address varchar NOT NULL,
      timezone varchar NOT NULL,
      status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
```

Then update `user_locations` to add the FK:

```ts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_identity.user_locations (
      user_id uuid REFERENCES platform_identity.users(id) ON DELETE CASCADE,
      location_id uuid NOT NULL REFERENCES platform_identity.locations(id) ON DELETE RESTRICT,
      PRIMARY KEY (user_id, location_id)
    )
  `);
```

- [ ] **Step 2: Add locations truncation to `truncateTables`**

In `truncateTables`, add locations truncation **after** `user_locations` (so FK is cleared first):

```ts
export async function truncateTables(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE platform_identity.api_keys CASCADE');
  await pool.query('TRUNCATE platform_identity.refresh_tokens CASCADE');
  await pool.query('TRUNCATE platform_identity.user_locations CASCADE');
  await pool.query('TRUNCATE platform_identity.users CASCADE');
  await pool.query('TRUNCATE platform_identity.locations CASCADE');
}
```

- [ ] **Step 3: Add `insertTestLocation` helper**

Add at the end of `helpers.ts`:

```ts
export async function insertTestLocation(
  pool: Pool,
  overrides: Partial<{
    name: string;
    phone: string;
    address: string;
    timezone: string;
    status: string;
  }> = {},
): Promise<{ id: string; name: string; phone: string; address: string; timezone: string; status: string }> {
  const result = await pool.query(
    `INSERT INTO platform_identity.locations (name, phone, address, timezone, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      overrides.name ?? 'Test Location',
      overrides.phone ?? '+15550000000',
      overrides.address ?? '1 Test St, New York, NY 10001',
      overrides.timezone ?? 'America/New_York',
      overrides.status ?? 'active',
    ],
  );
  return result.rows[0];
}
```

- [ ] **Step 4: Typecheck**

```bash
cd apps/platform/identity
npm run typecheck
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add test/integration/helpers.ts
git commit -m "test(identity): add locations table and helpers to integration setup"
```

---

## Task 6: Integration tests for location routes

**Files:**
- Create: `apps/platform/identity/test/integration/locations.test.ts`

- [ ] **Step 1: Write the integration tests**

Create `apps/platform/identity/test/integration/locations.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  setTestEnv,
  mockJwksFetch,
  warnIfSkipped,
  createSchema,
  truncateTables,
  createMockProvider,
  insertTestUser,
  insertTestLocation,
} from './helpers.js';

warnIfSkipped();
setTestEnv();
mockJwksFetch();

import type { FastifyInstance } from 'fastify';
import type { AuthProvider } from '../../src/providers/auth-provider.interface.js';

let pool: pg.Pool;
let app: FastifyInstance;
let provider: AuthProvider;
let signAccessToken: typeof import('../../src/services/token.service.js').signAccessToken;

function adminToken(userId: string) {
  return signAccessToken({ sub: userId, role: 'super_admin', locations: [], must_change_password: false });
}

function agentToken(userId: string) {
  return signAccessToken({ sub: userId, role: 'call_center_agent', locations: [], must_change_password: false });
}

describe.skipIf(!process.env['DATABASE_URL'])('locations routes integration', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await createSchema(pool);
    provider = createMockProvider();
    const { buildApp } = await import('../../src/app.js');
    const tokenService = await import('../../src/services/token.service.js');
    signAccessToken = tokenService.signAccessToken;
    app = await buildApp(pool, provider);
    await app.ready();
  });

  beforeEach(async () => {
    await truncateTables(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('POST /identity/locations', () => {
    it('creates a location and returns 201', async () => {
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'POST',
        url: '/identity/locations',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
        payload: { name: 'Downtown', phone: '+15551234567', address: '1 Main St', timezone: 'America/New_York' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.name).toBe('Downtown');
      expect(body.status).toBe('active');
    });

    it('returns 403 for non-super_admin', async () => {
      const user = await insertTestUser(pool, { role: 'call_center_agent' });
      const res = await app.inject({
        method: 'POST',
        url: '/identity/locations',
        headers: { authorization: `Bearer ${agentToken(user.id)}` },
        payload: { name: 'X', phone: '+1', address: 'Y', timezone: 'UTC' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /identity/locations', () => {
    it('returns all locations', async () => {
      await insertTestLocation(pool, { name: 'Alpha' });
      await insertTestLocation(pool, { name: 'Beta', status: 'inactive' });
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'GET',
        url: '/identity/locations',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().locations).toHaveLength(2);
    });

    it('filters by status', async () => {
      await insertTestLocation(pool, { name: 'Active' });
      await insertTestLocation(pool, { name: 'Inactive', status: 'inactive' });
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'GET',
        url: '/identity/locations?status=active',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(200);
      const locations = res.json().locations as Array<{ name: string }>;
      expect(locations).toHaveLength(1);
      expect(locations[0]!.name).toBe('Active');
    });
  });

  describe('GET /identity/locations/:id', () => {
    it('returns 200 with full location', async () => {
      const loc = await insertTestLocation(pool);
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'GET',
        url: `/identity/locations/${loc.id}`,
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(loc.id);
    });

    it('returns 404 for unknown id', async () => {
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'GET',
        url: '/identity/locations/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /identity/locations/:id', () => {
    it('updates name and returns 200', async () => {
      const loc = await insertTestLocation(pool);
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'PATCH',
        url: `/identity/locations/${loc.id}`,
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
        payload: { name: 'Updated Name' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Updated Name');
    });

    it('returns 404 for unknown id', async () => {
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'PATCH',
        url: '/identity/locations/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
        payload: { name: 'X' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 for non-super_admin', async () => {
      const loc = await insertTestLocation(pool);
      const user = await insertTestUser(pool, { role: 'call_center_agent' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/identity/locations/${loc.id}`,
        headers: { authorization: `Bearer ${agentToken(user.id)}` },
        payload: { name: 'X' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /identity/locations/:id', () => {
    it('soft-deletes and returns 204', async () => {
      const loc = await insertTestLocation(pool);
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'DELETE',
        url: `/identity/locations/${loc.id}`,
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(204);
      // Verify status is now inactive
      const check = await pool.query('SELECT status FROM platform_identity.locations WHERE id = $1', [loc.id]);
      expect(check.rows[0].status).toBe('inactive');
    });

    it('returns 404 for unknown id', async () => {
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'DELETE',
        url: '/identity/locations/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when location has assigned users', async () => {
      const loc = await insertTestLocation(pool);
      const user = await insertTestUser(pool, { role: 'call_center_agent' });
      await pool.query(
        'INSERT INTO platform_identity.user_locations (user_id, location_id) VALUES ($1, $2)',
        [user.id, loc.id],
      );
      const admin = await insertTestUser(pool, { email: 'admin2@example.com', provider_user_id: 'p2' });
      const res = await app.inject({
        method: 'DELETE',
        url: `/identity/locations/${loc.id}`,
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('location_has_users');
    });
  });
});
```

- [ ] **Step 2: Run unit tests to confirm they still pass**

```bash
cd apps/platform/identity
npx vitest run test/unit/location.repo.test.ts
```

Expected: all 8 PASS

- [ ] **Step 3: Run integration tests (requires DATABASE_URL)**

```bash
DATABASE_URL=postgresql://ortho:SecretPass123@localhost:5432/ortho npx vitest run test/integration/locations.test.ts
```

Expected: all 12 PASS (or SKIPPED if DATABASE_URL not set)

- [ ] **Step 4: Commit**

```bash
git add test/integration/locations.test.ts
git commit -m "test(identity): add location routes integration tests"
```

---

## Task 7: Gateway proxy route

**Files:**
- Create: `apps/crm/api-gateway/src/routes/locations.ts`
- Modify: `apps/crm/api-gateway/src/index.ts`

`IDENTITY_SERVICE_URL` is already in `config.ts` — no env var changes needed.

- [ ] **Step 1: Create the locations proxy route**

Create `apps/crm/api-gateway/src/routes/locations.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Route — /v1/locations/* pass-through proxy to Identity Service
// ---------------------------------------------------------------------------
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

async function locationsRoutes(app: FastifyInstance): Promise<void> {
  const handler: Parameters<typeof app.route>[0]['handler'] = async (request, reply) => {
    const upstreamPath = request.url.replace(/^\/v1/, '');
    return reply.from(`${config.IDENTITY_SERVICE_URL}${upstreamPath}`, {
      rewriteRequestHeaders: (_req, headers) => ({
        ...headers,
        ...request.authHeaders,
        'x-request-id': request.requestId,
      }),
    });
  };
  for (const url of ['/', '/*']) {
    app.route({ method: HTTP_METHODS, url, handler });
  }
}

export default locationsRoutes;
```

- [ ] **Step 2: Register the route in `apps/crm/api-gateway/src/index.ts`**

Add the import after the existing route imports:

```ts
import locationsRoutes from './routes/locations.js';
```

Register it after the existing service proxy registrations:

```ts
await app.register(locationsRoutes, { prefix: '/v1/locations' });
```

Also add `'locations'` to the `resolveUpstreamService` map:

```ts
const SERVICE_BY_PREFIX: Record<string, string> = {
  leads: 'lead-service',
  pipeline: 'pipeline-service',
  conversations: 'conversation-service',
  campaigns: 'campaign-service',
  referrals: 'referral-service',
  reports: 'reporting-service',
  imports: 'import-service',
  notifications: 'notification-service',
  locations: 'identity-service',
};
```

- [ ] **Step 3: Typecheck**

```bash
cd apps/crm/api-gateway
npm run typecheck
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/routes/locations.ts src/index.ts
git commit -m "feat(api-gateway): proxy /v1/locations to identity service"
```

---

## Task 8: CLI locations commands

**Files:**
- Create: `tools/crm-cli/src/commands/locations.ts`
- Modify: `tools/crm-cli/src/index.ts`

- [ ] **Step 1: Create the locations command file**

Create `tools/crm-cli/src/commands/locations.ts`:

```ts
import type { Command } from 'commander';
import { input, select, confirm } from '@inquirer/prompts';
import { request } from '../client.js';
import { printJson, printTable, printKeyValue, printSuccess, printError } from '../output.js';
import { withGlobals, handleError, type GlobalOpts } from '../util.js';

interface Location {
  id: string;
  name: string;
  phone: string;
  address: string;
  timezone: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const required = (v: string) => v.trim() ? true : 'Required';

export function registerLocationsCommands(program: Command): void {
  const locations = program.command('locations').description('Manage practice locations');

  // crm locations list
  withGlobals(locations.command('list'))
    .description('List all locations')
    .option('--status <status>', 'Filter by status: active | inactive')
    .action(async (opts: GlobalOpts & { status?: string }) => {
      try {
        const qs = opts.status ? `?status=${opts.status}` : '';
        const data = await request(`/locations${qs}`, { token: opts.token, gatewayUrl: opts.url }) as { locations: Location[] };
        if (opts.json) { printJson(data); return; }
        if (!data.locations.length) { console.log('No locations found.'); return; }
        printTable(
          ['ID', 'Name', 'Phone', 'Timezone', 'Status'],
          data.locations.map(l => [l.id.slice(0, 8) + '…', l.name, l.phone, l.timezone, l.status]),
        );
      } catch (err) { handleError(err); }
    });

  // crm locations get <id>
  withGlobals(locations.command('get <id>'))
    .description('Get a location by ID')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const loc = await request(`/locations/${id}`, { token: opts.token, gatewayUrl: opts.url }) as Location;
        if (opts.json) { printJson(loc); return; }
        printKeyValue({
          id:         loc.id,
          name:       loc.name,
          phone:      loc.phone,
          address:    loc.address,
          timezone:   loc.timezone,
          status:     loc.status,
          created_at: loc.created_at,
          updated_at: loc.updated_at,
        }, `Location: ${loc.name}`);
      } catch (err) { handleError(err); }
    });

  // crm locations create
  withGlobals(locations.command('create'))
    .description('Create a new location (interactive)')
    .action(async (opts: GlobalOpts) => {
      try {
        const name     = await input({ message: 'Name:',     validate: required });
        const phone    = await input({ message: 'Phone:',    validate: required });
        const address  = await input({ message: 'Address:',  validate: required });
        const timezone = await input({ message: 'Timezone (IANA, e.g. America/New_York):', validate: required });

        const loc = await request('/locations', {
          method: 'POST',
          body: { name, phone, address, timezone },
          token: opts.token,
          gatewayUrl: opts.url,
        }) as Location;

        if (opts.json) { printJson(loc); return; }
        printSuccess(`Location created: ${loc.name} (${loc.id})`);
      } catch (err) { handleError(err); }
    });

  // crm locations update <id>
  withGlobals(locations.command('update <id>'))
    .description('Update a location (interactive, pre-filled with current values)')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const current = await request(`/locations/${id}`, { token: opts.token, gatewayUrl: opts.url }) as Location;

        const name     = await input({ message: 'Name:',     default: current.name });
        const phone    = await input({ message: 'Phone:',    default: current.phone });
        const address  = await input({ message: 'Address:',  default: current.address });
        const timezone = await input({ message: 'Timezone:', default: current.timezone });
        const status   = await select({
          message: 'Status:',
          choices: [{ value: 'active' }, { value: 'inactive' }],
          default: current.status,
        });

        const body: Record<string, string> = {};
        if (name !== current.name)         body['name'] = name;
        if (phone !== current.phone)       body['phone'] = phone;
        if (address !== current.address)   body['address'] = address;
        if (timezone !== current.timezone) body['timezone'] = timezone;
        if (status !== current.status)     body['status'] = status;

        if (!Object.keys(body).length) { console.log('No changes made.'); return; }

        const loc = await request(`/locations/${id}`, {
          method: 'PATCH',
          body,
          token: opts.token,
          gatewayUrl: opts.url,
        }) as Location;

        if (opts.json) { printJson(loc); return; }
        printSuccess(`Location updated: ${loc.name}`);
      } catch (err) { handleError(err); }
    });

  // crm locations deactivate <id>
  withGlobals(locations.command('deactivate <id>'))
    .description('Deactivate a location (sets status=inactive)')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const current = await request(`/locations/${id}`, { token: opts.token, gatewayUrl: opts.url }) as Location;
        const confirmed = await confirm({
          message: `Deactivate "${current.name}"? This cannot be undone via CLI.`,
          default: false,
        });
        if (!confirmed) { console.log('Cancelled.'); return; }

        await request(`/locations/${id}`, {
          method: 'DELETE',
          token: opts.token,
          gatewayUrl: opts.url,
        });

        printSuccess(`Location deactivated: ${current.name}`);
      } catch (err) {
        const error = err as { body?: { error?: string } };
        if (error.body?.error === 'location_has_users') {
          printError('Cannot deactivate: location still has users assigned. Reassign them first.');
          return;
        }
        handleError(err);
      }
    });
}
```

- [ ] **Step 2: Register in `tools/crm-cli/src/index.ts`**

Add the import:
```ts
import { registerLocationsCommands } from './commands/locations.js';
```

Add the registration before `program.parse()`:
```ts
registerLocationsCommands(program);
```

- [ ] **Step 3: Typecheck**

```bash
cd tools/crm-cli
npm run typecheck
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/commands/locations.ts src/index.ts
git commit -m "feat(crm-cli): add locations command group"
```

---

## Self-Review

**Spec coverage:**
- ✅ `locations` table with all 8 columns — Task 1
- ✅ FK from `user_locations.location_id` to `locations.id` — Task 1
- ✅ `findAll`, `findById`, `create`, `update`, `softDelete` repository functions — Task 2
- ✅ `GET /identity/locations` with optional `?status` filter — Task 3
- ✅ `GET /identity/locations/:id` — Task 3
- ✅ `POST /identity/locations` (super_admin only) — Task 3
- ✅ `PATCH /identity/locations/:id` (super_admin only) — Task 3
- ✅ `DELETE /identity/locations/:id` soft-delete, 409 on FK violation — Task 3
- ✅ Read allowed for all authenticated users — Task 3 (no preHandler on GET routes)
- ✅ Registered in app.ts — Task 4
- ✅ Gateway proxy `/v1/locations` — Task 7
- ✅ `resolveUpstreamService` updated for logging — Task 7
- ✅ CLI: list, get, create, update, deactivate — Task 8
- ✅ Integration test helpers updated — Task 5
- ✅ Integration tests: full lifecycle + 403 + 404 + 409 — Task 6

**No placeholders found.**

**Type consistency:** `Location` type defined in `location.repo.ts` and used by routes. `insertTestLocation` returns `{ id, name, phone, address, timezone, status }` — sufficient for all test usages. CLI types `Location` interface locally (pattern matches other CLI commands). Consistent throughout.
