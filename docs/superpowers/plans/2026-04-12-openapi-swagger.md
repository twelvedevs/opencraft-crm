# OpenAPI / Swagger Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add interactive OpenAPI 3.0 docs (Swagger UI at `/docs`, spec at `/openapi.json`) to all 19 backend services via a shared `@ortho/openapi` Fastify plugin.

**Architecture:** A new `packages/@ortho/openapi` package wraps `@fastify/swagger` + `@fastify/swagger-ui`. Services register it once, before their route plugins. In production (`NODE_ENV=production`) the plugin is a no-op. Each service's routes gain `tags` and `summary` fields in their existing TypeBox `schema` objects. Health routes are hidden from the spec.

**Tech Stack:** Fastify 5, `@fastify/swagger@^9`, `@fastify/swagger-ui@^5`, `fastify-plugin@^5`, TypeBox (already in each service), Vitest 2.

---

## Route Annotation Pattern

For every Fastify route, add `tags` and `summary` to the `schema` object:

**Before:**
```ts
fastify.get('/rules/:id', {
  schema: {
    params: Type.Object({ id: Type.String() }),
    response: { 200: RuleSchema },
  },
}, handler);
```

**After:**
```ts
fastify.get('/rules/:id', {
  schema: {
    tags: ['Rules'],
    summary: 'Get rule by ID',
    params: Type.Object({ id: Type.String() }),
    response: { 200: RuleSchema },
  },
}, handler);
```

For routes with **no existing schema**, add one:
```ts
// Before
app.get('/health', async () => ({ ok: true }));

// After (health — hide from docs)
app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
```

For routes with **no existing schema** (not health):
```ts
// Before
fastify.get('/integrations/accounts', async (_req, _reply) => { ... });

// After
fastify.get('/integrations/accounts', { schema: { tags: ['Accounts'], summary: 'List integration accounts' } }, async (_req, _reply) => { ... });
```

---

## Task 1: Create `@ortho/openapi` package

**Files:**
- Create: `packages/@ortho/openapi/package.json`
- Create: `packages/@ortho/openapi/tsconfig.json`
- Create: `packages/@ortho/openapi/src/index.ts`
- Create: `packages/@ortho/openapi/test/plugin.test.ts`

- [x] **Step 1: Create directory structure**

```bash
mkdir -p packages/@ortho/openapi/src packages/@ortho/openapi/test
```

- [x] **Step 2: Create `packages/@ortho/openapi/package.json`**

```json
{
  "name": "@ortho/openapi",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fastify/swagger": "^9.0.0",
    "@fastify/swagger-ui": "^5.0.0",
    "fastify-plugin": "^5.0.0"
  },
  "peerDependencies": {
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "fastify": "^5.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

- [x] **Step 3: Create `packages/@ortho/openapi/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [x] **Step 4: Write failing test at `packages/@ortho/openapi/test/plugin.test.ts`**

```ts
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { openapiPlugin } from '../src/index.js';

describe('openapiPlugin — non-production', () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(openapiPlugin, {
      title: 'Test Service',
      description: 'Unit test service',
      tags: [{ name: 'Things', description: 'Things resource' }],
    });
    await app.ready();
  });

  afterAll(() => app.close());

  it('serves Swagger UI at /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('serves OpenAPI spec at /openapi.json', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as Record<string, unknown>;
    expect(spec['openapi']).toBe('3.0.0');
  });

  it('configures BearerAuth security scheme', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const spec = res.json() as {
      components: { securitySchemes: { BearerAuth: { scheme: string } } };
    };
    expect(spec.components.securitySchemes.BearerAuth.scheme).toBe('bearer');
  });

  it('includes provided tags in spec', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const spec = res.json() as { tags: Array<{ name: string }> };
    expect(spec.tags.some((t) => t.name === 'Things')).toBe(true);
  });
});

describe('openapiPlugin — production', () => {
  const app = Fastify();

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await app.register(openapiPlugin, { title: 'Test Service' });
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('does not register /docs in production', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(404);
  });

  it('does not register /openapi.json in production', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(404);
  });
});
```

- [x] **Step 5: Run tests — expect failure (plugin not implemented yet)**

```bash
cd packages/@ortho/openapi && npm install && npm test
```

Expected: tests fail with `Cannot find module '../src/index.js'` or similar.

- [x] **Step 6: Implement `packages/@ortho/openapi/src/index.ts`**

```ts
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';

export interface OpenApiPluginOptions {
  title: string;
  description?: string;
  version?: string;
  tags?: Array<{ name: string; description?: string }>;
}

const plugin: FastifyPluginAsync<OpenApiPluginOptions> = async (fastify, opts) => {
  if (process.env['NODE_ENV'] === 'production') return;

  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: opts.title,
        description: opts.description ?? '',
        version: opts.version ?? '1.0.0',
      },
      tags: opts.tags ?? [],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [{ BearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
  });
};

export const openapiPlugin = fp(plugin, {
  name: '@ortho/openapi',
  fastify: '5.x',
});
```

- [x] **Step 7: Run tests — expect all pass**

```bash
npm test
```

Expected output: `Tests 6 passed (6)`

- [x] **Step 8: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [x] **Step 9: Commit**

```bash
cd ../../.. && git add packages/@ortho/openapi && git commit -m "feat(@ortho/openapi): add shared Fastify OpenAPI plugin"
```

---

## Task 2: platform/automation

**Files:**
- Modify: `apps/platform/automation/package.json`
- Modify: `apps/platform/automation/src/index.ts`
- Modify: `apps/platform/automation/src/routes/rules.ts`
- Modify: `apps/platform/automation/src/routes/executions.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| rules.ts | GET | /rules | Rules | List automation rules |
| rules.ts | GET | /rules/:id | Rules | Get rule by ID |
| rules.ts | POST | /rules | Rules | Create automation rule |
| rules.ts | PUT | /rules/:id | Rules | Update automation rule |
| rules.ts | PUT | /rules/:id/versions/:v/activate | Rules | Activate rule version |
| rules.ts | PATCH | /rules/:id/status | Rules | Update rule status |
| rules.ts | DELETE | /rules/:id | Rules | Delete automation rule |
| rules.ts | POST | /rules/:id/test | Rules | Test rule with event |
| executions.ts | GET | /executions | Executions | List executions |
| executions.ts | GET | /executions/:executionId/steps/:stepId/output | Executions | Get step output |

- [x] **Step 1: Add dependency to `apps/platform/automation/package.json`**

Add to `"dependencies"`:
```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/automation && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/automation/src/index.ts`**

Add import after existing imports:
```ts
import { openapiPlugin } from '@ortho/openapi';
```

Add registration after `await fastify.register(sensible);`:
```ts
await fastify.register(openapiPlugin, {
  title: 'Automation Engine',
  description: 'Event-driven workflow runtime',
  tags: [
    { name: 'Rules', description: 'Automation rule management' },
    { name: 'Executions', description: 'Execution history' },
  ],
});
```

- [x] **Step 4: Hide healthz in `apps/platform/automation/src/index.ts`**

Change:
```ts
fastify.get('/healthz', async () => {
  return { ok: true };
});
```
To:
```ts
fastify.get('/healthz', { schema: { hide: true } }, async () => {
  return { ok: true };
});
```

- [x] **Step 5: Add tags+summary to every route schema in `rules.ts` and `executions.ts`**

For each route in the table above, add `tags` and `summary` to its `schema` object. Example for `GET /rules`:
```ts
fastify.get('/rules', {
  schema: {
    tags: ['Rules'],
    summary: 'List automation rules',
    querystring: Type.Object({ ... }),
    response: { 200: Type.Array(RuleSchema) },
  },
}, handler);
```

Apply to all 10 routes listed in the table.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/automation && git commit -m "feat(automation): add OpenAPI/Swagger docs"
```

---

## Task 3: platform/nurturing

**Files:**
- Modify: `apps/platform/nurturing/package.json`
- Modify: `apps/platform/nurturing/src/index.ts` (in `createApp()`)
- Modify: `apps/platform/nurturing/src/routes/sequences.ts`
- Modify: `apps/platform/nurturing/src/routes/enrollments.ts`
- Modify: `apps/platform/nurturing/src/routes/stats.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| sequences.ts | GET | /sequences | Sequences | List sequences |
| sequences.ts | POST | /sequences | Sequences | Create sequence |
| sequences.ts | GET | /sequences/:id | Sequences | Get sequence by ID |
| sequences.ts | PUT | /sequences/:id | Sequences | Update sequence |
| sequences.ts | POST | /sequences/:id/activate | Sequences | Activate sequence |
| sequences.ts | POST | /sequences/:id/disable | Sequences | Disable sequence |
| enrollments.ts | GET | /sequences/:id/enrollments | Enrollments | List enrollments for sequence |
| enrollments.ts | GET | /sequences/:id/enrollments/:eid | Enrollments | Get enrollment by ID |
| enrollments.ts | GET | /sequences/:id/enrollments/:eid/steps/:sid | Enrollments | Get enrollment step |
| enrollments.ts | POST | /sequences/enroll | Enrollments | Enroll entity in sequence |
| enrollments.ts | POST | /sequences/unenroll | Enrollments | Unenroll entity from sequence |
| stats.ts | GET | /sequences/:id/stats | Stats | Get sequence statistics |

- [x] **Step 1: Add dependency to `apps/platform/nurturing/package.json`**

Add to `"dependencies"`:
```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/nurturing && npm install
```

- [x] **Step 3: Register plugin in `createApp()` in `apps/platform/nurturing/src/index.ts`**

Add import at top:
```ts
import { openapiPlugin } from '@ortho/openapi';
```

Inside `createApp()`, after `await fastify.register(sensible);`:
```ts
await fastify.register(openapiPlugin, {
  title: 'Nurturing Engine',
  description: 'Generic drip/lifecycle sequence runtime',
  tags: [
    { name: 'Sequences', description: 'Sequence definition management' },
    { name: 'Enrollments', description: 'Entity enrollment in sequences' },
    { name: 'Stats', description: 'Sequence statistics' },
  ],
});
```

- [x] **Step 4: Hide healthz in `createApp()` in `apps/platform/nurturing/src/index.ts`**

Change:
```ts
fastify.get('/healthz', async () => {
  return { ok: true };
});
```
To:
```ts
fastify.get('/healthz', { schema: { hide: true } }, async () => {
  return { ok: true };
});
```

- [x] **Step 5: Add tags+summary to all routes in sequences.ts, enrollments.ts, stats.ts**

Apply the table above to each route's `schema` object. For routes without an existing schema, add `schema: { tags: [...], summary: '...' }`.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/nurturing && git commit -m "feat(nurturing): add OpenAPI/Swagger docs"
```

---

## Task 4: platform/notification

**Files:**
- Modify: `apps/platform/notification/package.json`
- Modify: `apps/platform/notification/src/index.ts`
- Modify: `apps/platform/notification/src/routes/notifications.ts`
- Modify: `apps/platform/notification/src/routes/publish.ts`
- Modify: `apps/platform/notification/src/routes/stream.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| notifications.ts | GET | /notifications | Notifications | List notifications |
| notifications.ts | POST | /notifications/read-all | Notifications | Mark all notifications as read |
| notifications.ts | POST | /notifications/:id/read | Notifications | Mark notification as read |
| publish.ts | POST | /notifications/publish | Publish | Publish notification to users |
| stream.ts | GET | /notifications/stream | Stream | SSE stream of real-time notifications |

- [x] **Step 1: Add dependency to `apps/platform/notification/package.json`**

Add to `"dependencies"`:
```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/notification && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/notification/src/index.ts`**

Add import at top:
```ts
import { openapiPlugin } from '@ortho/openapi';
```

Add registration after `export const app = Fastify({ logger: true });` and before route registrations:
```ts
await app.register(openapiPlugin, {
  title: 'Notification Service',
  description: 'Real-time in-app notifications via SSE',
  tags: [
    { name: 'Notifications', description: 'Notification management' },
    { name: 'Publish', description: 'Publish notifications' },
    { name: 'Stream', description: 'Real-time SSE stream' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/platform/notification/src/index.ts`**

Change:
```ts
app.get('/health', async () => {
  return { status: 'ok' };
});
```
To:
```ts
app.get('/health', { schema: { hide: true } }, async () => {
  return { status: 'ok' };
});
```

- [x] **Step 5: Add tags+summary to all routes in notifications.ts, publish.ts, stream.ts**

Apply the table above.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/notification && git commit -m "feat(notification): add OpenAPI/Swagger docs"
```

---

## Task 5: platform/messaging

**Files:**
- Modify: `apps/platform/messaging/package.json`
- Modify: `apps/platform/messaging/src/app.ts` (`buildApp()`)
- Modify: `apps/platform/messaging/src/routes/health.ts`
- Modify: `apps/platform/messaging/src/routes/messages.ts`
- Modify: `apps/platform/messaging/src/routes/numbers.ts`
- Modify: `apps/platform/messaging/src/routes/opt-outs.ts`
- Modify: `apps/platform/messaging/src/routes/webhooks.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| messages.ts | POST | /messages/send | Messages | Send SMS message |
| messages.ts | GET | /messages/:id | Messages | Get message by ID |
| messages.ts | GET | /messages | Messages | List messages |
| numbers.ts | POST | /numbers | Numbers | Provision Twilio number |
| numbers.ts | DELETE | /numbers/:id | Numbers | Release Twilio number |
| numbers.ts | GET | /numbers | Numbers | List numbers |
| numbers.ts | GET | /numbers/resolve | Numbers | Resolve number by phone |
| opt-outs.ts | GET | /opt-outs/:phone | Opt-outs | Check opt-out status for phone |
| opt-outs.ts | POST | /opt-outs | Opt-outs | Add opt-out |
| opt-outs.ts | DELETE | /opt-outs/:phone | Opt-outs | Remove opt-out |
| webhooks.ts | POST | /webhooks/twilio/inbound | Webhooks | Twilio inbound message webhook |
| webhooks.ts | POST | /webhooks/twilio/status | Webhooks | Twilio status callback webhook |

- [x] **Step 1: Add dependency to `apps/platform/messaging/package.json`**

Add to `"dependencies"`:
```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/messaging && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/messaging/src/app.ts`**

Add import at top:
```ts
import { openapiPlugin } from '@ortho/openapi';
```

Inside `buildApp()`, after `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Messaging Service',
  description: 'SMS/MMS/Voice via Twilio',
  tags: [
    { name: 'Messages', description: 'SMS message sending and retrieval' },
    { name: 'Numbers', description: 'Twilio number pool management' },
    { name: 'Opt-outs', description: 'STOP/opt-out handling' },
    { name: 'Webhooks', description: 'Twilio webhook receivers' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/platform/messaging/src/routes/health.ts`**

Change:
```ts
app.get('/health', async (_req, reply) => {
```
To:
```ts
app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
```

- [x] **Step 5: Add tags+summary to all routes in messages.ts, numbers.ts, opt-outs.ts, webhooks.ts**

Apply the table above to each route's schema.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/messaging && git commit -m "feat(messaging): add OpenAPI/Swagger docs"
```

---

## Task 6: platform/email

**Files:**
- Modify: `apps/platform/email/package.json`
- Modify: `apps/platform/email/src/app.ts` (`buildApp()`)
- Modify: `apps/platform/email/src/routes/health.ts`
- Modify: `apps/platform/email/src/routes/sends.ts`
- Modify: `apps/platform/email/src/routes/campaigns.ts`
- Modify: `apps/platform/email/src/routes/domains.ts`
- Modify: `apps/platform/email/src/routes/spam-check.ts`
- Modify: `apps/platform/email/src/routes/webhooks.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| sends.ts | POST | /send | Sends | Send transactional email |
| campaigns.ts | POST | /campaigns/send | Bulk Campaigns | Send bulk email campaign |
| campaigns.ts | GET | /campaigns/:jobId | Bulk Campaigns | Get campaign send status |
| campaigns.ts | GET | /campaigns/:jobId/recipients | Bulk Campaigns | List campaign recipients |
| campaigns.ts | DELETE | /campaigns/:jobId | Bulk Campaigns | Cancel campaign job |
| domains.ts | POST | /domains | Domains | Add sending domain |
| domains.ts | GET | /domains | Domains | List sending domains |
| domains.ts | GET | /domains/:id | Domains | Get domain by ID |
| domains.ts | DELETE | /domains/:id | Domains | Delete sending domain |
| spam-check.ts | POST | /spam-check | Spam Check | Check email spam score |
| webhooks.ts | POST | /webhooks/sendgrid | Webhooks | SendGrid event webhook |

- [x] **Step 1: Add dependency to `apps/platform/email/package.json`**

Add to `"dependencies"`:
```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/email && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/email/src/app.ts`**

Add import at top:
```ts
import { openapiPlugin } from '@ortho/openapi';
```

Inside `buildApp()`, after `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Email Service',
  description: 'Email delivery via SendGrid',
  tags: [
    { name: 'Sends', description: 'Transactional email sending' },
    { name: 'Bulk Campaigns', description: 'Bulk email campaign delivery' },
    { name: 'Domains', description: 'Dedicated sending domain management' },
    { name: 'Spam Check', description: 'Email spam score checking' },
    { name: 'Webhooks', description: 'SendGrid event webhooks' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/platform/email/src/routes/health.ts`**

Change:
```ts
app.get('/health', async (_req, reply) => {
```
To:
```ts
app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
```

- [x] **Step 5: Add tags+summary to all routes in sends.ts, campaigns.ts, domains.ts, spam-check.ts, webhooks.ts**

Apply the table above.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/email && git commit -m "feat(email): add OpenAPI/Swagger docs"
```

---

## Task 7: platform/template

**Files:**
- Modify: `apps/platform/template/package.json`
- Modify: `apps/platform/template/src/app.ts`
- Modify: `apps/platform/template/src/routes/templates.ts`
- Modify: `apps/platform/template/src/routes/render.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| templates.ts | POST | /templates | Templates | Create template |
| templates.ts | GET | /templates | Templates | List templates |
| templates.ts | GET | /templates/:id | Templates | Get template by ID |
| templates.ts | POST | /templates/:id/enable | Templates | Enable template |
| templates.ts | POST | /templates/:id/disable | Templates | Disable template |
| templates.ts | POST | /templates/:id/activate | Templates | Activate template version |
| templates.ts | PATCH | /templates/:id | Templates | Update template |
| render.ts | POST | /templates/render | Render | Render template with merge tags |

The `app.ts` for template service has its health route inline. Check `apps/platform/template/src/app.ts` for the health route and add `{ schema: { hide: true } }` to it.

- [x] **Step 1: Add dependency to `apps/platform/template/package.json`**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/template && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/template/src/app.ts`**

Add import:
```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Template Service',
  description: 'Template storage and rendering engine',
  tags: [
    { name: 'Templates', description: 'Template management and versioning' },
    { name: 'Render', description: 'Template rendering with merge tags' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/platform/template/src/app.ts`**

Find the inline `/health` route and add `{ schema: { hide: true } }`.

- [x] **Step 5: Add tags+summary to all routes in templates.ts and render.ts**

Apply the table above.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/template && git commit -m "feat(template): add OpenAPI/Swagger docs"
```

---

## Task 8: platform/audience

**Files:**
- Modify: `apps/platform/audience/package.json`
- Modify: `apps/platform/audience/src/app.ts`
- Modify: `apps/platform/audience/src/routes/health.ts`
- Modify: `apps/platform/audience/src/routes/segments.ts`
- Modify: `apps/platform/audience/src/routes/evaluate.ts`
- Modify: `apps/platform/audience/src/routes/check.ts`
- Modify: `apps/platform/audience/src/routes/snapshots.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| segments.ts | POST | /audiences/segments | Segments | Create audience segment |
| segments.ts | PUT | /audiences/segments/:id | Segments | Update audience segment |
| segments.ts | GET | /audiences/segments | Segments | List audience segments |
| segments.ts | POST | /audiences/segments/:id/activate | Segments | Activate segment |
| segments.ts | POST | /audiences/segments/:id/disable | Segments | Disable segment |
| segments.ts | GET | /audiences/segments/:id | Segments | Get segment by ID |
| evaluate.ts | POST | /audiences/segments/:id/evaluate | Evaluation | Evaluate segment membership |
| evaluate.ts | POST | /audiences/evaluate | Evaluation | Evaluate filter against entity list |
| check.ts | POST | /audiences/segments/:id/check | Evaluation | Check single entity membership |
| snapshots.ts | GET | /audiences/snapshots/:snapshot_id | Snapshots | Get audience snapshot |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/audience && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/audience/src/app.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Audience Engine',
  description: 'Schema-agnostic segment filter evaluation',
  tags: [
    { name: 'Segments', description: 'Audience segment definition' },
    { name: 'Evaluation', description: 'Segment membership evaluation' },
    { name: 'Snapshots', description: 'Audience snapshot retrieval' },
  ],
});
```

- [x] **Step 4: Hide health in `apps/platform/audience/src/routes/health.ts`**

```ts
app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
```

- [x] **Step 5: Add tags+summary to segments.ts, evaluate.ts, check.ts, snapshots.ts**

Apply the table above.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/audience && git commit -m "feat(audience): add OpenAPI/Swagger docs"
```

---

## Task 9: platform/ai

**Files:**
- Modify: `apps/platform/ai/package.json`
- Modify: `apps/platform/ai/src/app.ts`
- Modify: `apps/platform/ai/src/routes/health.ts`
- Modify: `apps/platform/ai/src/routes/complete.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| complete.ts | POST | /ai/complete | Completions | Request Claude completion |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/ai && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/ai/src/app.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'AI Service',
  description: 'Claude API gateway with prompt management and response caching',
  tags: [
    { name: 'Completions', description: 'Claude API completions' },
  ],
});
```

- [x] **Step 4: Hide health in `apps/platform/ai/src/routes/health.ts`**

```ts
app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
```

- [x] **Step 5: Add tags+summary to complete.ts**

Apply the table above.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/ai && git commit -m "feat(ai): add OpenAPI/Swagger docs"
```

---

## Task 10: platform/analytics

**Files:**
- Modify: `apps/platform/analytics/package.json`
- Modify: `apps/platform/analytics/src/app.ts`
- Modify: `apps/platform/analytics/src/routes/health.ts`
- Modify: `apps/platform/analytics/src/routes/query.ts`
- Modify: `apps/platform/analytics/src/routes/admin.ts`
- Modify: `apps/platform/analytics/src/routes/metrics/ad-spend.ts`
- Modify: `apps/platform/analytics/src/routes/metrics/leads.ts`
- Modify: `apps/platform/analytics/src/routes/metrics/pipeline.ts`
- Modify: `apps/platform/analytics/src/routes/metrics/campaigns.ts`
- Modify: `apps/platform/analytics/src/routes/metrics/conversions.ts`
- Modify: `apps/platform/analytics/src/routes/metrics/coordinators.ts`
- Modify: `apps/platform/analytics/src/routes/metrics/messages.ts`
- Modify: `apps/platform/analytics/src/routes/metrics/referrals.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| query.ts | POST | /analytics/query | Query | Execute ad-hoc analytics query |
| admin.ts | POST | /analytics/admin/recompute | Admin | Trigger metric recomputation |
| admin.ts | GET | /analytics/admin/recompute/:job_id | Admin | Get recomputation job status |
| metrics/ad-spend.ts | GET | /analytics/metrics/ad-spend | Metrics | Get ad spend metrics |
| metrics/ad-spend.ts | GET | /analytics/metrics/ad-spend/campaigns | Metrics | Get ad spend by campaign |
| metrics/leads.ts | GET | /analytics/metrics/leads | Metrics | Get lead metrics |
| metrics/pipeline.ts | GET | /analytics/metrics/pipeline | Metrics | Get pipeline funnel metrics |
| metrics/campaigns.ts | GET | /analytics/metrics/campaigns | Metrics | Get campaign metrics |
| metrics/conversions.ts | GET | /analytics/metrics/conversions | Metrics | Get conversion metrics |
| metrics/coordinators.ts | GET | /analytics/metrics/coordinators | Metrics | Get coordinator metrics |
| metrics/messages.ts | GET | /analytics/metrics/messages | Metrics | Get messaging metrics |
| metrics/referrals.ts | GET | /analytics/metrics/referrals | Metrics | Get referral metrics |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/analytics && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/analytics/src/app.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Analytics Service',
  description: 'Event ingestion pipeline and metric aggregation',
  tags: [
    { name: 'Metrics', description: 'Aggregated metric queries' },
    { name: 'Query', description: 'Ad-hoc raw event queries' },
    { name: 'Admin', description: 'Administrative operations' },
  ],
});
```

- [x] **Step 4: Hide health in `apps/platform/analytics/src/routes/health.ts`**

```ts
app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
```

- [x] **Step 5: Add tags+summary to all routes listed in the table**

Apply all 12 route annotations.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/analytics && git commit -m "feat(analytics): add OpenAPI/Swagger docs"
```

---

## Task 11: platform/integration-hub

**Files:**
- Modify: `apps/platform/integration-hub/package.json`
- Modify: `apps/platform/integration-hub/src/app.ts`
- Modify: `apps/platform/integration-hub/src/routes/accounts.ts`
- Modify: `apps/platform/integration-hub/src/routes/oauth.ts`
- Modify: `apps/platform/integration-hub/src/routes/backfill.ts`
- Modify: `apps/platform/integration-hub/src/routes/webhooks.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| accounts.ts | GET | /integrations/accounts | Accounts | List integration accounts |
| accounts.ts | GET | /integrations/accounts/:id/campaigns | Accounts | List campaigns for account |
| accounts.ts | PUT | /integrations/accounts/:id/mappings | Accounts | Update account campaign mappings |
| oauth.ts | GET | /integrations/connect/:platform | OAuth | Start OAuth authorization flow |
| oauth.ts | GET | /integrations/oauth/:platform/callback | OAuth | OAuth callback handler |
| oauth.ts | DELETE | /integrations/accounts/:id | OAuth | Disconnect integration account |
| backfill.ts | POST | /integrations/accounts/:id/backfill | Backfill | Trigger historical data backfill |
| backfill.ts | GET | /integrations/accounts/:id/backfill/:job_id | Backfill | Get backfill job status |
| webhooks.ts | POST | /integrations/webhooks/:platform | Webhooks | Receive ad platform webhook |
| webhooks.ts | GET | /integrations/webhooks/:platform/verify | Webhooks | Verify ad platform webhook |

The `app.ts` has an inline health route. Add `{ schema: { hide: true } }` to it.

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/integration-hub && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/integration-hub/src/app.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `await fastify.register(sensible);`:
```ts
await fastify.register(openapiPlugin, {
  title: 'Integration Hub',
  description: 'External API connectors — Google Ads and Meta Marketing APIs',
  tags: [
    { name: 'Accounts', description: 'Integration account management' },
    { name: 'OAuth', description: 'OAuth authorization flows' },
    { name: 'Backfill', description: 'Historical data backfill jobs' },
    { name: 'Webhooks', description: 'Ad platform webhook receivers' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/platform/integration-hub/src/app.ts`**

Find `fastify.get('/health', ...)` inline and add `{ schema: { hide: true } }`.

- [x] **Step 5: Add tags+summary to all routes listed in the table**

Apply all 10 route annotations.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/integration-hub && git commit -m "feat(integration-hub): add OpenAPI/Swagger docs"
```

---

## Task 12: platform/identity

**Files:**
- Modify: `apps/platform/identity/package.json`
- Modify: `apps/platform/identity/src/app.ts`
- Modify: `apps/platform/identity/src/routes/health.ts`
- Modify: `apps/platform/identity/src/routes/users.ts`
- Modify: `apps/platform/identity/src/routes/api-keys.ts`
- Modify: `apps/platform/identity/src/routes/session.ts`
- Modify: `apps/platform/identity/src/routes/me.ts`
- Modify: `apps/platform/identity/src/routes/jwks.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| users.ts | POST | /identity/users | Users | Create user |
| users.ts | GET | /identity/users | Users | List users |
| users.ts | GET | /identity/users/:id | Users | Get user by ID |
| users.ts | PUT | /identity/users/:id | Users | Update user |
| users.ts | PUT | /identity/users/:id/password | Users | Update user password |
| api-keys.ts | POST | /identity/api-keys/validate | API Keys | Validate API key |
| api-keys.ts | POST | /identity/api-keys | API Keys | Create API key |
| api-keys.ts | GET | /identity/api-keys | API Keys | List API keys |
| api-keys.ts | DELETE | /identity/api-keys/:id | API Keys | Revoke API key |
| session.ts | POST | /identity/session | Session | Create session (login) |
| session.ts | POST | /identity/refresh | Session | Refresh access token |
| session.ts | DELETE | /identity/session | Session | Delete session (logout) |
| me.ts | GET | /identity/me | Me | Get current user profile |
| me.ts | PUT | /identity/me/password | Me | Change own password |
| jwks.ts | GET | /identity/.well-known/jwks.json | JWKS | Get public key set |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/identity && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/identity/src/app.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Identity Service',
  description: 'Authentication, RBAC, and multi-location scoping',
  tags: [
    { name: 'Session', description: 'Login, logout, token refresh' },
    { name: 'Me', description: 'Current user profile' },
    { name: 'Users', description: 'User management' },
    { name: 'API Keys', description: 'Service API key management' },
    { name: 'JWKS', description: 'Public key set for JWT verification' },
  ],
});
```

- [x] **Step 4: Hide health in `apps/platform/identity/src/routes/health.ts`**

```ts
app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
```

- [x] **Step 5: Add tags+summary to all 15 routes listed in the table**

Apply all route annotations.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/identity && git commit -m "feat(identity): add OpenAPI/Swagger docs"
```

---

## Task 13: platform/media

**Files:**
- Modify: `apps/platform/media/package.json`
- Modify: `apps/platform/media/src/app.ts`
- Modify: `apps/platform/media/src/routes/upload.ts`
- Modify: `apps/platform/media/src/routes/files.ts`
- Modify: `apps/platform/media/src/routes/internal.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| upload.ts | POST | /media/upload-url | Upload | Request presigned S3 upload URL |
| upload.ts | POST | /media/confirm/:upload_id | Upload | Confirm upload completion |
| upload.ts | POST | /media/upload | Upload | Direct multipart upload |
| files.ts | GET | /media/:file_id | Files | Get file metadata and CDN URL |
| files.ts | DELETE | /media/:file_id | Files | Delete file |
| internal.ts | POST | /media/internal/store | Internal | Store file from internal service |
| internal.ts | GET | /media/internal/:file_id/signed-url | Internal | Get internal signed URL |

The `app.ts` has an inline health route. Add `{ schema: { hide: true } }` to it.

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/platform/media && npm install
```

- [x] **Step 3: Register plugin in `apps/platform/media/src/app.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Media Service',
  description: 'File upload, S3 storage, and CDN delivery',
  tags: [
    { name: 'Upload', description: 'File upload flows' },
    { name: 'Files', description: 'File retrieval and deletion' },
    { name: 'Internal', description: 'Internal service file operations' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/platform/media/src/app.ts`**

Find `app.get('/health', ...)` inline and add `{ schema: { hide: true } }`.

- [x] **Step 5: Add tags+summary to upload.ts, files.ts, internal.ts**

Apply the table above.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/platform/media && git commit -m "feat(media): add OpenAPI/Swagger docs"
```

---

## Task 14: crm/lead

**Files:**
- Modify: `apps/crm/lead/package.json`
- Modify: `apps/crm/lead/src/app.ts` (`buildApp()`)
- Modify: `apps/crm/lead/src/routes/leads.ts`
- Modify: `apps/crm/lead/src/routes/activities.ts`
- Modify: `apps/crm/lead/src/routes/appointments.ts`
- Modify: `apps/crm/lead/src/routes/tags.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| leads.ts | POST | /leads | Leads | Create lead |
| leads.ts | GET | /leads/duplicates | Leads | List duplicate lead pairs |
| leads.ts | PATCH | /leads/:id/duplicate-status | Leads | Update duplicate status |
| leads.ts | POST | /leads/:id/merge | Leads | Merge duplicate leads |
| leads.ts | GET | /leads | Leads | List leads |
| leads.ts | GET | /leads/:id | Leads | Get lead by ID |
| leads.ts | PATCH | /leads/:id | Leads | Update lead |
| leads.ts | DELETE | /leads/:id | Leads | Delete lead |
| activities.ts | GET | /leads/:id/activities | Activities | List lead activity timeline |
| activities.ts | GET | /leads/:id/score-commentary | Activities | Get AI score commentary |
| appointments.ts | POST | /leads/:id/appointments | Appointments | Create appointment |
| appointments.ts | GET | /leads/:id/appointments | Appointments | List lead appointments |
| appointments.ts | PATCH | /leads/:id/appointments/:appt_id | Appointments | Update appointment |
| appointments.ts | DELETE | /leads/:id/appointments/:appt_id | Appointments | Delete appointment |
| tags.ts | GET | /tags | Tags | List all tags |
| tags.ts | POST | /tags | Tags | Create tag |
| tags.ts | DELETE | /tags/:id | Tags | Delete tag |
| tags.ts | POST | /leads/:id/tags | Tags | Apply tag to lead |
| tags.ts | DELETE | /leads/:id/tags/:tag_id | Tags | Remove tag from lead |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/crm/lead && npm install
```

- [x] **Step 3: Register plugin in `apps/crm/lead/src/app.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

Inside `buildApp()`, after `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Lead Service',
  description: 'Lead records, attribution, deduplication, and activity timeline',
  tags: [
    { name: 'Leads', description: 'Lead CRUD and deduplication' },
    { name: 'Activities', description: 'Lead activity timeline' },
    { name: 'Appointments', description: 'Lead appointment management' },
    { name: 'Tags', description: 'Tag management and assignment' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/crm/lead/src/app.ts`**

Change:
```ts
app.get('/health', async () => ({ ok: true }));
```
To:
```ts
app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
```

- [x] **Step 5: Add tags+summary to leads.ts, activities.ts, appointments.ts, tags.ts**

Apply all 19 route annotations from the table.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/crm/lead && git commit -m "feat(lead): add OpenAPI/Swagger docs"
```

---

## Task 15: crm/pipeline

**Files:**
- Modify: `apps/crm/pipeline/package.json`
- Modify: `apps/crm/pipeline/src/app.ts`
- Modify: `apps/crm/pipeline/src/routes/memberships.ts`
- Modify: `apps/crm/pipeline/src/routes/transitions.ts`
- Modify: `apps/crm/pipeline/src/routes/conversions.ts`
- Modify: `apps/crm/pipeline/src/routes/close.ts`
- Modify: `apps/crm/pipeline/src/routes/history.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| memberships.ts | POST | /memberships | Memberships | Enroll lead in pipeline |
| memberships.ts | GET | /memberships | Memberships | List pipeline memberships |
| memberships.ts | GET | /memberships/:id | Memberships | Get membership by ID |
| transitions.ts | POST | /memberships/:id/transition | Transitions | Transition membership to stage |
| conversions.ts | POST | /memberships/:id/convert | Conversions | Convert lead to new pipeline |
| close.ts | POST | /memberships/:id/close | Close | Close/archive membership |
| history.ts | GET | /memberships/:id/history | History | Get membership stage history |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/crm/pipeline && npm install
```

- [x] **Step 3: Register plugin in `apps/crm/pipeline/src/app.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Pipeline Engine',
  description: 'State machine for 3 patient pipelines and 13 stages',
  tags: [
    { name: 'Memberships', description: 'Pipeline membership management' },
    { name: 'Transitions', description: 'Stage transition execution' },
    { name: 'Conversions', description: 'Cross-pipeline conversion' },
    { name: 'Close', description: 'Membership archival' },
    { name: 'History', description: 'Stage transition history' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/crm/pipeline/src/app.ts`**

```ts
app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
```

- [x] **Step 5: Add tags+summary to memberships.ts, transitions.ts, conversions.ts, close.ts, history.ts**

Apply the table above. For routes that currently have `schema: { body: ... }` without tags, add `tags` and `summary` to the existing schema. For routes without any schema, add `schema: { tags: [...], summary: '...' }`.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/crm/pipeline && git commit -m "feat(pipeline): add OpenAPI/Swagger docs"
```

---

## Task 16: crm/conversation

**Files:**
- Modify: `apps/crm/conversation/package.json`
- Modify: `apps/crm/conversation/src/app.ts`
- Modify: `apps/crm/conversation/src/routes/conversations.ts`
- Modify: `apps/crm/conversation/src/routes/messages.ts`
- Modify: `apps/crm/conversation/src/routes/notes.ts`
- Modify: `apps/crm/conversation/src/routes/bulk-sends.ts`
- Modify: `apps/crm/conversation/src/routes/ai.ts`
- Modify: `apps/crm/conversation/src/routes/scheduled.ts`
- Modify: `apps/crm/conversation/src/routes/settings.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| conversations.ts | GET | / | Conversations | List conversations |
| conversations.ts | GET | /:id | Conversations | Get conversation by ID |
| conversations.ts | PATCH | /:id | Conversations | Update conversation |
| conversations.ts | POST | /:id/read | Conversations | Mark conversation as read |
| messages.ts | GET | /:id/messages | Messages | List conversation messages |
| messages.ts | POST | /:id/messages | Messages | Send message in conversation |
| notes.ts | POST | /:id/notes | Notes | Add internal note |
| notes.ts | DELETE | /:id/notes/:note_id | Notes | Delete internal note |
| bulk-sends.ts | POST | /bulk-sends | Bulk Sends | Send bulk SMS to segment |
| bulk-sends.ts | GET | /bulk-sends/:job_id | Bulk Sends | Get bulk send job status |
| ai.ts | POST | /:id/ai/drafts | AI | Generate AI reply drafts |
| ai.ts | POST | /:id/ai/summary | AI | Generate conversation summary |
| ai.ts | POST | /:id/ai/objection | AI | Get objection handling suggestions |
| scheduled.ts | POST | /:id/scheduled-messages | Scheduled Messages | Schedule a future message |
| scheduled.ts | GET | /:id/scheduled-messages | Scheduled Messages | List scheduled messages |
| scheduled.ts | DELETE | /:id/scheduled-messages/:msg_id | Scheduled Messages | Cancel scheduled message |
| settings.ts | GET | /settings/locations/:id | Settings | Get location inbox settings |
| settings.ts | PATCH | /settings/locations/:id | Settings | Update location inbox settings |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/crm/conversation && npm install
```

- [x] **Step 3: Register plugin in `apps/crm/conversation/src/app.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Conversation Service',
  description: 'SMS inbox per location — conversation threading and AI-assisted messaging',
  tags: [
    { name: 'Conversations', description: 'Conversation management' },
    { name: 'Messages', description: 'Message sending and retrieval' },
    { name: 'Notes', description: 'Internal staff notes' },
    { name: 'Bulk Sends', description: 'Bulk SMS to segments' },
    { name: 'AI', description: 'AI-assisted reply drafting and summaries' },
    { name: 'Scheduled Messages', description: 'Future-dated message scheduling' },
    { name: 'Settings', description: 'Location inbox settings' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/crm/conversation/src/app.ts`**

```ts
app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
```

- [x] **Step 5: Add tags+summary to all 18 routes in the table**

Apply all route annotations.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/crm/conversation && git commit -m "feat(conversation): add OpenAPI/Swagger docs"
```

---

## Task 17: crm/campaign

**Files:**
- Modify: `apps/crm/campaign/package.json`
- Modify: `apps/crm/campaign/src/api.ts` (`buildApp()`)
- Modify: `apps/crm/campaign/src/routes/campaigns.ts`
- Modify: `apps/crm/campaign/src/routes/workflow.ts`
- Modify: `apps/crm/campaign/src/routes/comments.ts`
- Modify: `apps/crm/campaign/src/routes/diagnostics.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| campaigns.ts | POST | /campaigns | Campaigns | Create campaign |
| campaigns.ts | GET | /campaigns | Campaigns | List campaigns |
| campaigns.ts | GET | /campaigns/:id | Campaigns | Get campaign by ID |
| campaigns.ts | PATCH | /campaigns/:id | Campaigns | Update campaign |
| campaigns.ts | DELETE | /campaigns/:id | Campaigns | Delete campaign |
| workflow.ts | POST | /campaigns/:id/submit | Workflow | Submit campaign for approval |
| workflow.ts | POST | /campaigns/:id/approve | Workflow | Approve campaign |
| workflow.ts | POST | /campaigns/:id/reject | Workflow | Reject campaign |
| workflow.ts | POST | /campaigns/:id/cancel | Workflow | Cancel campaign |
| workflow.ts | POST | /campaigns/:id/schedule | Workflow | Schedule campaign send |
| comments.ts | POST | /campaigns/:id/comments | Comments | Add review comment |
| comments.ts | GET | /campaigns/:id/comments | Comments | List campaign comments |
| diagnostics.ts | GET | /campaigns/:id/sends | Diagnostics | List campaign send records |
| diagnostics.ts | GET | /campaigns/:id/conversions | Diagnostics | List campaign conversions |
| diagnostics.ts | POST | /campaigns/:id/test-send | Diagnostics | Send test email |
| diagnostics.ts | POST | /campaigns/:id/spam-check | Diagnostics | Check campaign spam score |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/crm/campaign && npm install
```

- [x] **Step 3: Register plugin in `apps/crm/campaign/src/api.ts`**

The Fastify instance is created in `buildApp()` in `api.ts`. Add import and registration:

```ts
import { openapiPlugin } from '@ortho/openapi';
```

Inside `buildApp()`, after `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Campaign Service',
  description: 'Email broadcast campaigns with approval workflow',
  tags: [
    { name: 'Campaigns', description: 'Campaign management' },
    { name: 'Workflow', description: 'Approval and scheduling workflow' },
    { name: 'Comments', description: 'Review comments' },
    { name: 'Diagnostics', description: 'Send diagnostics and spam checking' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/crm/campaign/src/api.ts`**

```ts
app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
```

- [x] **Step 5: Add tags+summary to campaigns.ts, workflow.ts, comments.ts, diagnostics.ts**

Apply all 16 route annotations.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/crm/campaign && git commit -m "feat(campaign): add OpenAPI/Swagger docs"
```

---

## Task 18: crm/referral

**Files:**
- Modify: `apps/crm/referral/package.json`
- Modify: `apps/crm/referral/src/index.ts`
- Modify: `apps/crm/referral/src/routes/referrals.ts`
- Modify: `apps/crm/referral/src/routes/referrers.ts`
- Modify: `apps/crm/referral/src/routes/referral-links.ts`
- Modify: `apps/crm/referral/src/routes/rewards.ts`
- Modify: `apps/crm/referral/src/routes/leaderboard.ts`
- Modify: `apps/crm/referral/src/routes/public/links.ts`
- Modify: `apps/crm/referral/src/routes/public/portal.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| referrals.ts | GET | /referrals | Referrals | List referrals |
| referrals.ts | GET | /referrals/:id | Referrals | Get referral by ID |
| referrals.ts | PATCH | /referrals/:id/notifications | Referrals | Update referral notification settings |
| referrers.ts | POST | /referrals/referrers | Referrers | Create referrer |
| referrers.ts | GET | /referrals/referrers | Referrers | List referrers |
| referrers.ts | GET | /referrals/referrers/:id | Referrers | Get referrer by ID |
| referrers.ts | PATCH | /referrals/referrers/:id | Referrers | Update referrer |
| referrers.ts | PATCH | /referrals/referrers/:id/status | Referrers | Update referrer status |
| referral-links.ts | POST | /referrals/referrers/:id/links | Referral Links | Create referral link |
| referral-links.ts | GET | /referrals/referrers/:id/links | Referral Links | List referral links |
| referral-links.ts | PATCH | /referrals/links/:id/status | Referral Links | Update referral link status |
| rewards.ts | GET | /referrals/rewards | Rewards | List pending rewards |
| rewards.ts | PATCH | /referrals/rewards/:id | Rewards | Mark reward as issued |
| leaderboard.ts | GET | /referrals/leaderboard | Leaderboard | Get referral leaderboard |
| public/links.ts | GET | /referrals/r/:code | Public | Redirect referral link click |
| public/links.ts | GET | /referrals/links/:code | Public | Resolve referral link metadata |
| public/portal.ts | GET | /referrals/portal/:token | Public | Get referring doctor portal view |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/crm/referral && npm install
```

- [x] **Step 3: Register plugin in `apps/crm/referral/src/index.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `const app = Fastify(...)` and `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Referral Service',
  description: 'Referral link generation, click tracking, and conversion attribution',
  tags: [
    { name: 'Referrals', description: 'Referral records' },
    { name: 'Referrers', description: 'Referring doctor and patient management' },
    { name: 'Referral Links', description: 'Unique referral link management' },
    { name: 'Rewards', description: 'Referral reward tracking' },
    { name: 'Leaderboard', description: 'Top referrers leaderboard' },
    { name: 'Public', description: 'Public referral link endpoints' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/crm/referral/src/index.ts`**

```ts
app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
```

- [x] **Step 5: Add tags+summary to all 17 routes in the table**

Apply all route annotations.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/crm/referral && git commit -m "feat(referral): add OpenAPI/Swagger docs"
```

---

## Task 19: crm/reporting

**Files:**
- Modify: `apps/crm/reporting/package.json`
- Modify: `apps/crm/reporting/src/index.ts`
- Modify: `apps/crm/reporting/src/routes/health.ts`
- Modify: `apps/crm/reporting/src/routes/dashboard.ts`
- Modify: `apps/crm/reporting/src/routes/runs.ts`
- Modify: `apps/crm/reporting/src/routes/schedules.ts`
- Modify: `apps/crm/reporting/src/routes/config.ts`
- Modify: `apps/crm/reporting/src/routes/report-configs.ts`
- Modify: `apps/crm/reporting/src/routes/metrics/channel-performance.ts`
- Modify: `apps/crm/reporting/src/routes/metrics/location-comparison.ts`
- Modify: `apps/crm/reporting/src/routes/metrics/campaign-analytics.ts`
- Modify: `apps/crm/reporting/src/routes/metrics/coordinator-performance.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| dashboard.ts | GET | /reporting/dashboard | Dashboard | Get executive dashboard summary |
| runs.ts | GET | /reporting/runs | Runs | List report runs |
| runs.ts | GET | /reporting/runs/:id | Runs | Get report run by ID |
| runs.ts | GET | /reporting/runs/:id/download | Runs | Download report run as PDF/CSV |
| runs.ts | POST | /reporting/runs/:id/retry | Runs | Retry failed report run |
| schedules.ts | GET | /reporting/schedules | Schedules | List report schedules |
| schedules.ts | POST | /reporting/schedules | Schedules | Create report schedule |
| schedules.ts | PUT | /reporting/schedules/:id | Schedules | Update report schedule |
| schedules.ts | DELETE | /reporting/schedules/:id | Schedules | Delete report schedule |
| config.ts | GET | /reporting/config/revenue | Config | Get revenue config |
| config.ts | GET | /reporting/config/revenue/:location_id | Config | Get revenue config for location |
| report-configs.ts | GET | /reporting/report-configs | Report Configs | List report configurations |
| report-configs.ts | POST | /reporting/report-configs | Report Configs | Create report configuration |
| report-configs.ts | GET | /reporting/report-configs/:id | Report Configs | Get report config by ID |
| report-configs.ts | PUT | /reporting/report-configs/:id | Report Configs | Update report configuration |
| report-configs.ts | POST | /reporting/report-configs/:id/generate | Report Configs | Generate report from configuration |
| metrics/channel-performance.ts | GET | /reporting/metrics/channel-performance | Metrics | Get channel performance metrics |
| metrics/location-comparison.ts | GET | /reporting/metrics/location-comparison | Metrics | Get location comparison metrics |
| metrics/campaign-analytics.ts | GET | /reporting/metrics/campaign-analytics | Metrics | Get campaign analytics metrics |
| metrics/coordinator-performance.ts | GET | /reporting/metrics/coordinator-performance | Metrics | Get coordinator performance metrics |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/crm/reporting && npm install
```

- [x] **Step 3: Register plugin in `apps/crm/reporting/src/index.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `const app = Fastify(...)` and `await app.register(sensible);`:
```ts
await app.register(openapiPlugin, {
  title: 'Reporting Service',
  description: 'Ortho-specific reporting — cost per case, ROAS, funnel rates, coordinator metrics',
  tags: [
    { name: 'Dashboard', description: 'Executive dashboard' },
    { name: 'Metrics', description: 'Aggregated performance metrics' },
    { name: 'Runs', description: 'Report run management' },
    { name: 'Schedules', description: 'Scheduled report delivery' },
    { name: 'Report Configs', description: 'Saved report configurations' },
    { name: 'Config', description: 'Revenue and global config' },
  ],
});
```

- [x] **Step 4: Hide health in `apps/crm/reporting/src/routes/health.ts`**

```ts
app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
```

- [x] **Step 5: Add tags+summary to all 20 routes in the table**

Apply all route annotations.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/crm/reporting && git commit -m "feat(reporting): add OpenAPI/Swagger docs"
```

---

## Task 20: crm/import

**Files:**
- Modify: `apps/crm/import/package.json`
- Modify: `apps/crm/import/src/index.ts`
- Modify: `apps/crm/import/src/routes/imports.ts`
- Modify: `apps/crm/import/src/routes/mappings.ts`
- Modify: `apps/crm/import/src/routes/rows.ts`
- Modify: `apps/crm/import/src/routes/actions.ts`

**Route annotations:**

| File | Method | Path | Tag | Summary |
|------|--------|------|-----|---------|
| imports.ts | POST | /imports | Imports | Upload and create import job |
| imports.ts | GET | /imports | Imports | List import jobs |
| imports.ts | GET | /imports/:id | Imports | Get import job by ID |
| mappings.ts | GET | /imports/column-mappings/:type | Mappings | Get column mapping template by type |
| rows.ts | GET | /imports/:id/rows | Rows | List import rows with match status |
| actions.ts | POST | /imports/:id/confirm | Actions | Confirm and execute import |
| actions.ts | POST | /imports/:id/cancel | Actions | Cancel pending import |
| actions.ts | POST | /imports/:id/undo | Actions | Undo completed import |

- [x] **Step 1: Add dependency**

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

- [x] **Step 2: Install**

```bash
cd apps/crm/import && npm install
```

- [x] **Step 3: Register plugin in `apps/crm/import/src/index.ts`**

```ts
import { openapiPlugin } from '@ortho/openapi';
```

After `const app = Fastify(...)` and plugin registrations, before route registrations:
```ts
await app.register(openapiPlugin, {
  title: 'Data Import Service',
  description: 'Ortho2 CSV parsing, column mapping, and 5-tier match logic',
  tags: [
    { name: 'Imports', description: 'Import job management' },
    { name: 'Mappings', description: 'Column mapping templates' },
    { name: 'Rows', description: 'Import row inspection' },
    { name: 'Actions', description: 'Confirm, cancel, and undo imports' },
  ],
});
```

- [x] **Step 4: Hide health route in `apps/crm/import/src/index.ts`**

```ts
app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
```

- [x] **Step 5: Add tags+summary to imports.ts, mappings.ts, rows.ts, actions.ts**

Apply the 8 route annotations from the table above.

- [x] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
cd ../../.. && git add apps/crm/import && git commit -m "feat(import): add OpenAPI/Swagger docs"
```

---

## Self-Review Checklist

- [x] All 19 services covered (Tasks 2–20)
- [x] CRM API Gateway excluded
- [x] `@ortho/openapi` package has tests
- [x] Production no-op behavior tested
- [x] JWT BearerAuth security scheme configured
- [x] Health routes hidden in all services
- [x] Route annotations: tags + summary only (no descriptions)
- [x] `file:` dependency paths use `../../../packages/@ortho/openapi` (correct for both `apps/platform/*` and `apps/crm/*` depths)
- [x] Services with `app.ts`/`api.ts`: plugin registered in that file
- [x] Services with inline `index.ts`: plugin registered in `index.ts`
- [x] `/healthz` (automation, nurturing) vs `/health` (all others) handled correctly
- [x] `fastify-plugin` wrapper used so swagger routes are not encapsulated
