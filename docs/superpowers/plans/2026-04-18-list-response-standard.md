# List Response Standard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardise all 19 collection endpoints to return `{ data: T[], nextCursor?: string | null, total?: number }`, add a shared `PaginatedResponse<T>` type to `@ortho/types`, and update all affected tests and QA scenarios.

**Architecture:** Route handlers are changed to explicitly wrap repo/service results in the new envelope — repos and services keep their internal naming unchanged to minimise blast radius. `@ortho/types` gets a shared generic type that services may adopt incrementally.

**Tech Stack:** TypeScript 5, Fastify 5, TypeBox 0.34, Vitest 2.

**Spec:** `docs/superpowers/specs/2026-04-18-list-response-standard-design.md`
**ADR:** `docs/arch/adr-list-response-standard.md`

---

## Task 1: Add `PaginatedResponse<T>` to `@ortho/types`

**Files:**
- Create: `packages/@ortho/types/src/pagination.ts`
- Modify: `packages/@ortho/types/src/index.ts`

- [ ] **Step 1: Create the pagination types file**

```typescript
// packages/@ortho/types/src/pagination.ts
export interface PaginatedResponse<T> {
  data: T[];
  nextCursor?: string | null;
  total?: number;
}

/** Exception: GET /imports/:id/rows uses integer row_number as cursor */
export interface RowPaginatedResponse<T> {
  data: T[];
  nextCursor: number | null;
}
```

- [ ] **Step 2: Export from index**

In `packages/@ortho/types/src/index.ts`, add:
```typescript
export * from './events.js';
export * from './actions.js';
export * from './pagination.js';  // ← add this line
```

- [ ] **Step 3: Typecheck the package**

```bash
cd packages/@ortho/types && npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/@ortho/types/src/pagination.ts packages/@ortho/types/src/index.ts
git commit -m "feat(types): add PaginatedResponse and RowPaginatedResponse shared types"
```

---

## Task 2: Lead Service — list, duplicates, activities, appointments

**Files:**
- Modify: `apps/crm/lead/src/routes/leads.ts`
- Modify: `apps/crm/lead/src/routes/activities.ts`
- Modify: `apps/crm/lead/src/routes/appointments.ts`
- Modify: `apps/crm/lead/test/integration/activities.test.ts`

### Activities (has integration tests — do TDD)

- [ ] **Step 1: Update activities test to assert `data` key**

In `apps/crm/lead/test/integration/activities.test.ts`, replace every `body.activities` with `body.data` and every `body1.activities` with `body1.data`, `body2.activities` with `body2.data`. Exact replacements:

| Old | New |
|-----|-----|
| `body.activities` | `body.data` |
| `body1.activities` | `body1.data` |
| `body2.activities` | `body2.data` |

Also update type annotations in that file wherever `activities: Array<...>` appears in `res.json<...>()` calls — change to `data: Array<...>`.

`nextCursor` stays as-is (already camelCase).

- [ ] **Step 2: Run activities tests — expect failure**

```bash
cd apps/crm/lead && npx vitest run test/integration/activities.test.ts
```
Expected: FAIL — `body.data` is undefined (current response has `body.activities`).

- [ ] **Step 3: Update activities route handler**

In `apps/crm/lead/src/routes/activities.ts`, line 48:
```typescript
// Before
return reply.status(200).send(result);

// After  (result = { activities: Activity[], nextCursor: string | null })
return reply.status(200).send({ data: result.activities, nextCursor: result.nextCursor });
```

- [ ] **Step 4: Run activities tests — expect pass**

```bash
cd apps/crm/lead && npx vitest run test/integration/activities.test.ts
```
Expected: all PASS.

### Lead list, bulk lookup, and appointments (no list integration tests — change handler directly)

- [ ] **Step 5: Update lead list handlers**

In `apps/crm/lead/src/routes/leads.ts`:

Lines 256–274 (bulk lookup branches), change each:
```typescript
// Before (3 occurrences)
return reply.status(200).send({ leads });

// After
return reply.status(200).send({ data: leads });
```

Line ~296 (normal list mode), change:
```typescript
// Before  (result = { leads: Lead[], nextCursor: string | null })
return reply.status(200).send(result);

// After
return reply.status(200).send({ data: result.leads, nextCursor: result.nextCursor });
```

- [ ] **Step 6: Update appointments list handler**

In `apps/crm/lead/src/routes/appointments.ts`, line ~75:
```typescript
// Before  (appointments is a plain array)
const appointments = await appointmentService.listAppointments(db, id);
return reply.status(200).send(appointments);

// After
const appointments = await appointmentService.listAppointments(db, id);
return reply.status(200).send({ data: appointments });
```

- [ ] **Step 7: Run full lead test suite**

```bash
cd apps/crm/lead && npm run test
```
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/crm/lead/src/routes/leads.ts \
        apps/crm/lead/src/routes/activities.ts \
        apps/crm/lead/src/routes/appointments.ts \
        apps/crm/lead/test/integration/activities.test.ts
git commit -m "feat(lead): standardise list responses to { data } envelope"
```

---

## Task 3: Campaign Service — campaigns list

**Files:**
- Modify: `apps/crm/campaign/src/routes/campaigns.ts`

No integration test asserts on the campaign list response shape — change the handler directly.

- [ ] **Step 1: Find the list handler**

Open `apps/crm/campaign/src/routes/campaigns.ts`. Find the `GET /` or `GET /campaigns` handler. It ends with:
```typescript
return reply.status(200).send(result);
```
Where `result` comes from `campaignsRepo.list(db, { ... })` which returns `{ items: Campaign[], total: number }`.

- [ ] **Step 2: Update the handler**

```typescript
// Before
return reply.status(200).send(result);

// After
return reply.status(200).send({ data: result.items, total: result.total });
```

- [ ] **Step 3: Run campaign tests**

```bash
cd apps/crm/campaign && npm run test
```
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/crm/campaign/src/routes/campaigns.ts
git commit -m "feat(campaign): standardise list response to { data } envelope"
```

---

## Task 4: Conversation Service — conversations list

**Files:**
- Modify: `apps/crm/conversation/src/routes/conversations.ts`
- Modify: `apps/crm/conversation/test/integration/reads.test.ts`

- [ ] **Step 1: Update reads test**

In `apps/crm/conversation/test/integration/reads.test.ts`, lines 131–133:
```typescript
// Before
const { rows } = listRes.json();
expect(rows).toHaveLength(1);
expect(rows[0].unread_count).toBe(0);

// After
const { data } = listRes.json();
expect(data).toHaveLength(1);
expect(data[0].unread_count).toBe(0);
```

- [ ] **Step 2: Run conversation tests — expect failure**

```bash
cd apps/crm/conversation && npx vitest run test/integration/reads.test.ts
```
Expected: FAIL — `data` is undefined (current response has `rows`).

- [ ] **Step 3: Update the list handler**

In `apps/crm/conversation/src/routes/conversations.ts`, find the `GET /` list handler. The repo returns `{ rows: ConversationListRow[], total: number }`. Change:
```typescript
// Before
return reply.send(result);

// After  (result = { rows: ConversationListRow[], total: number })
return reply.send({ data: result.rows, total: result.total });
```

- [ ] **Step 4: Run conversation tests — expect pass**

```bash
cd apps/crm/conversation && npm run test
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/crm/conversation/src/routes/conversations.ts \
        apps/crm/conversation/test/integration/reads.test.ts
git commit -m "feat(conversation): standardise list response to { data } envelope"
```

---

## Task 5: Pipeline Service — memberships list

**Files:**
- Modify: `apps/crm/pipeline/src/routes/memberships.ts`
- Modify: `apps/crm/pipeline/test/integration/memberships.test.ts`

The memberships list test has many assertions on `body.rows` / `body.nextCursor`.

- [ ] **Step 1: Update memberships test**

In `apps/crm/pipeline/test/integration/memberships.test.ts`, replace all occurrences of `.rows` (when referring to the list response body) with `.data`:

| Old | New |
|-----|-----|
| `body.rows` | `body.data` |
| `body1.rows` | `body1.data` |
| `body2.rows` | `body2.data` |
| `res.json().rows` | `res.json().data` |
| `resInactive.json().rows` | `resInactive.json().data` |
| `resOther.json().rows` | `resOther.json().data` |

`nextCursor` already camelCase — no change needed.

- [ ] **Step 2: Run memberships tests — expect failure**

```bash
cd apps/crm/pipeline && npx vitest run test/integration/memberships.test.ts
```
Expected: FAIL — `body.data` is undefined (current response has `body.rows`).

- [ ] **Step 3: Update the list handler**

In `apps/crm/pipeline/src/routes/memberships.ts`, find the `GET /pipeline/memberships` handler. It ends with `return reply.status(200).send(result)` where `result = { rows: Membership[], nextCursor: string | null }`. Change:
```typescript
// Before
return reply.status(200).send(result);

// After
return reply.status(200).send({ data: result.rows, nextCursor: result.nextCursor });
```

- [ ] **Step 4: Run pipeline tests — expect pass**

```bash
cd apps/crm/pipeline && npm run test
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/crm/pipeline/src/routes/memberships.ts \
        apps/crm/pipeline/test/integration/memberships.test.ts
git commit -m "feat(pipeline): standardise list response to { data } envelope"
```

---

## Task 6: Referral Service — referrers, referrals, rewards

**Files:**
- Modify: `apps/crm/referral/src/routes/referrers.ts`
- Modify: `apps/crm/referral/src/routes/referrals.ts`
- Modify: the rewards list route (find via `grep -r "GET.*rewards\|listRewards\|list.*reward" apps/crm/referral/src/routes/`)

No list integration tests to update.

- [ ] **Step 1: Update referrers list handler**

In `apps/crm/referral/src/routes/referrers.ts`, find the `GET /` list handler. The service returns `{ items: Referrer[], nextCursor: string | null }`. Change:
```typescript
// Before
return reply.status(200).send(result);

// After
return reply.status(200).send({ data: result.items, nextCursor: result.nextCursor });
```

- [ ] **Step 2: Update referrals list handler**

In `apps/crm/referral/src/routes/referrals.ts`, same pattern:
```typescript
// Before
return reply.status(200).send(result);

// After  (result = { items: Referral[], nextCursor: string | null })
return reply.status(200).send({ data: result.items, nextCursor: result.nextCursor });
```

- [ ] **Step 3: Update rewards list handler**

Find the rewards list handler (look for `GET /rewards` or similar in `apps/crm/referral/src/routes/`). Same pattern:
```typescript
// Before
return reply.status(200).send(result);

// After  (result = { items: RewardEvent[], nextCursor: string | null })
return reply.status(200).send({ data: result.items, nextCursor: result.nextCursor });
```

- [ ] **Step 4: Run referral tests**

```bash
cd apps/crm/referral && npm run test
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/crm/referral/src/routes/referrers.ts \
        apps/crm/referral/src/routes/referrals.ts
git commit -m "feat(referral): standardise list responses to { data } envelope"
```
(Add any rewards route file to the `git add` command.)

---

## Task 7: Identity Service — users and api-keys

**Files:**
- Modify: `apps/platform/identity/src/routes/users.ts`
- Modify: `apps/platform/identity/src/routes/api-keys.ts`

No list integration tests to update.

- [ ] **Step 1: Update users list handler**

In `apps/platform/identity/src/routes/users.ts`, the `GET /identity/users` handler (around line 92–100):
```typescript
// Before
return reply.status(200).send({
  users: result.rows,
  next_cursor: result.nextCursor,
});

// After
return reply.status(200).send({
  data: result.rows,
  nextCursor: result.nextCursor,
});
```

- [ ] **Step 2: Update api-keys list handler**

In `apps/platform/identity/src/routes/api-keys.ts`, the `GET /identity/api-keys` handler (around line 88–96):
```typescript
// Before
return reply.status(200).send({
  keys: keys.map((k) => ({
    id: k.id,
    name: k.name,
    permissions: k.permissions,
    last_used_at: k.last_used_at,
    status: k.revoked_at ? 'revoked' : 'active',
  })),
});

// After
return reply.status(200).send({
  data: keys.map((k) => ({
    id: k.id,
    name: k.name,
    permissions: k.permissions,
    last_used_at: k.last_used_at,
    status: k.revoked_at ? 'revoked' : 'active',
  })),
});
```

- [ ] **Step 3: Run identity tests**

```bash
cd apps/platform/identity && npm run test
```
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/identity/src/routes/users.ts \
        apps/platform/identity/src/routes/api-keys.ts
git commit -m "feat(identity): standardise list responses to { data } envelope"
```

---

## Task 8: Audience Service — segments list

**Files:**
- Modify: `apps/platform/audience/src/routes/segments.ts`
- Modify: `apps/platform/audience/test/integration/segments.test.ts`

- [ ] **Step 1: Update segments test**

In `apps/platform/audience/test/integration/segments.test.ts`, replace all `body.items` with `body.data` and all `json().items` with `json().data`. Affected lines (approximate): 223, 224, 251, 269, 270, 276, 277.

Example:
```typescript
// Before (line 223)
expect(body.items).toHaveLength(1);
expect(body.items[0].status).toBe('active');

// After
expect(body.data).toHaveLength(1);
expect(body.data[0].status).toBe('active');
```

Also update `page1.json().items` → `page1.json().data`, `page2.json().items` → `page2.json().data`.

`total` stays unchanged.

- [ ] **Step 2: Run segments test — expect failure**

```bash
cd apps/platform/audience && npx vitest run test/integration/segments.test.ts
```
Expected: FAIL — `body.data` is undefined.

- [ ] **Step 3: Update the list handler**

In `apps/platform/audience/src/routes/segments.ts`, around line 130:
```typescript
// Before
return reply.status(200).send({
  items: result.items.map((s) => ({
    segment_id: s.id,
    name: s.name,
    status: s.status,
    active_version: s.active_version,
    current_version: s.current_version,
    updated_at: s.updated_at,
  })),
  total: result.total,
});

// After
return reply.status(200).send({
  data: result.items.map((s) => ({
    segment_id: s.id,
    name: s.name,
    status: s.status,
    active_version: s.active_version,
    current_version: s.current_version,
    updated_at: s.updated_at,
  })),
  total: result.total,
});
```

- [ ] **Step 4: Run audience tests — expect pass**

```bash
cd apps/platform/audience && npm run test
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/audience/src/routes/segments.ts \
        apps/platform/audience/test/integration/segments.test.ts
git commit -m "feat(audience): standardise list response to { data } envelope"
```

---

## Task 9: Messaging Service — messages list

**Files:**
- Modify: `apps/platform/messaging/src/routes/messages.ts`

The messaging repo returns `{ data: Message[], next_cursor: string | null, has_more: boolean }`. The route does `reply.send(result)`. We keep the `data` key but rename `next_cursor` → `nextCursor` and drop `has_more`.

No list integration tests to update.

- [ ] **Step 1: Update the list handler**

In `apps/platform/messaging/src/routes/messages.ts`, find the `GET /messages` handler. Change:
```typescript
// Before
return reply.send(result);

// After  (result = { data: Message[], next_cursor: string | null, has_more: boolean })
return reply.send({ data: result.data, nextCursor: result.next_cursor });
```

- [ ] **Step 2: Run messaging tests**

```bash
cd apps/platform/messaging && npm run test
```
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/platform/messaging/src/routes/messages.ts
git commit -m "feat(messaging): standardise list response — nextCursor, drop has_more"
```

---

## Task 10: Email Service — campaign recipients list

**Files:**
- Modify: `apps/platform/email/src/routes/campaigns.ts`

No list integration tests to update.

- [ ] **Step 1: Update the recipients list handler**

In `apps/platform/email/src/routes/campaigns.ts`, around lines 214–239, the `GET /campaigns/:jobId/recipients` handler:
```typescript
// Before
return reply.status(200).send({
  recipients,
  total,
  page,
  page_size: 100,
});

// After
return reply.status(200).send({
  data: recipients,
  total,
});
```

- [ ] **Step 2: Run email tests**

```bash
cd apps/platform/email && npm run test
```
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/platform/email/src/routes/campaigns.ts
git commit -m "feat(email): standardise recipients list response to { data } envelope"
```

---

## Task 11: Template Service — remove `limit`/`offset` from response

**Files:**
- Modify: `apps/platform/template/src/routes/templates.ts`
- Modify: `apps/platform/template/test/integration/templates-crud.test.ts`

The template service already returns `{ data: rows, total, limit, offset }`. We only need to drop `limit` and `offset` from the response (they remain as query params). The test at line 98 asserts on them.

- [ ] **Step 1: Update the template list test**

In `apps/platform/template/test/integration/templates-crud.test.ts`, line 98:
```typescript
// Before
const body = await res.json() as { data: unknown[]; total: number; limit: number; offset: number };
expect(body.total).toBe(3);
expect(body.data.length).toBe(3);
expect(body.limit).toBe(20);
expect(body.offset).toBe(0);

// After
const body = await res.json() as { data: unknown[]; total: number };
expect(body.total).toBe(3);
expect(body.data.length).toBe(3);
```

- [ ] **Step 2: Run template list tests — expect failure**

```bash
cd apps/platform/template && npx vitest run test/integration/templates-crud.test.ts
```
Expected: the test that previously checked `body.limit` now has no such assertion, so this step may already PASS. If no failure occurs, proceed directly — it means the old assertions were simply removed and the test is now weaker (which is correct).

- [ ] **Step 3: Update the route handler**

In `apps/platform/template/src/routes/templates.ts`, around line 88:
```typescript
// Before
return reply.status(200).send({
  data: rows,
  total,
  limit: resolvedLimit,
  offset: resolvedOffset,
});

// After
return reply.status(200).send({
  data: rows,
  total,
});
```

- [ ] **Step 4: Run template tests — expect pass**

```bash
cd apps/platform/template && npm run test
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/template/src/routes/templates.ts \
        apps/platform/template/test/integration/templates-crud.test.ts
git commit -m "feat(template): standardise list response — remove limit/offset from envelope"
```

---

## Task 12: Notification Service — rename key and camelCase cursor

**Files:**
- Modify: `apps/platform/notification/src/routes/notifications.ts`
- Modify: `apps/platform/notification/test/integration/history.test.ts`

The notification test is the most heavily updated — it has ~15 references to `body.notifications` and `body.next_cursor`.

- [ ] **Step 1: Update history test**

In `apps/platform/notification/test/integration/history.test.ts`, make these replacements globally (every occurrence):

| Old | New |
|-----|-----|
| `body.notifications` | `body.data` |
| `body1.notifications` | `body1.data` |
| `body2.notifications` | `body2.data` |
| `body.next_cursor` | `body.nextCursor` |
| `body1.next_cursor` | `body1.nextCursor` |
| `body2.next_cursor` | `body2.nextCursor` |
| `notifications: Array<` | `data: Array<` |
| `next_cursor: string \| null` | `nextCursor: string \| null` |

Also update the `before=` query param usage at line ~145 from `body1.next_cursor` to `body1.nextCursor`.

- [ ] **Step 2: Run history test — expect failure**

```bash
cd apps/platform/notification && npx vitest run test/integration/history.test.ts
```
Expected: FAIL — `body.data` is undefined (current response has `body.notifications`).

- [ ] **Step 3: Update the notifications list handler**

In `apps/platform/notification/src/routes/notifications.ts`, around the `GET /notifications` handler response (the block that destructures `{ rows, nextCursor, totalUnread }`):
```typescript
// Before
return reply.status(200).send({
  notifications: rows.map(rowToResponse),
  next_cursor: nextCursor,
});

// After
return reply.status(200).send({
  data: rows.map(rowToResponse),
  nextCursor,
});
```

The `X-Total-Count` header for `totalUnread` stays unchanged.

- [ ] **Step 4: Run notification tests — expect pass**

```bash
cd apps/platform/notification && npm run test
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/notification/src/routes/notifications.ts \
        apps/platform/notification/test/integration/history.test.ts
git commit -m "feat(notification): standardise list response to { data } envelope"
```

---

## Task 13: QA Scenarios — update `body_contains` assertions

**Files:**
- Modify: `tools/qa/scenarios.yaml`

Update `body_contains` for every list scenario to match the new response shapes.

- [ ] **Step 1: Update all list scenario assertions**

Open `tools/qa/scenarios.yaml` and apply these changes:

| Scenario ID | Old `body_contains` | New `body_contains` |
|-------------|--------------------|--------------------|
| `user-list` | `["users"]` | `["data"]` |
| `lead-list` | `["leads", "nextCursor"]` | `["data", "nextCursor"]` |
| `lead-duplicates-list` | `["leads", "nextCursor"]` | `["data", "nextCursor"]` |
| `lead-activities` | `["activities", "nextCursor"]` | `["data", "nextCursor"]` |
| `appointment-list` | `["appointment_type"]` | `["data"]` |
| `campaign-list` | `["items", "total"]` | `["data", "total"]` |
| `conversation-list` | `["rows", "total"]` | `["data", "total"]` |
| `pipeline-memberships-list` | `["data"]` | `["data"]` (no change) |
| `referrer-list` | `["items", "nextCursor"]` | `["data", "nextCursor"]` |
| `referral-list` | `["items", "nextCursor"]` | `["data", "nextCursor"]` |
| `referral-rewards-list` | `["items", "nextCursor"]` | `["data", "nextCursor"]` |
| `notification-list` | `["notifications", "next_cursor"]` | `["data", "nextCursor"]` |
| `api-key-list` | `["data"]` | `["data"]` (no change) |
| `referral-link-list` | `["data"]` | `["data"]` (no change) |

Verify the actual current values in the file before editing — they may have changed from the initial audit.

- [ ] **Step 2: Typecheck QA runner**

```bash
cd tools/qa && npm run build 2>/dev/null || npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add tools/qa/scenarios.yaml
git commit -m "fix(qa): update body_contains assertions to { data } list envelope"
```

---

## Self-Review Notes

- `@ortho/types` export uses `.js` extension (`'./pagination.js'`) — required for ESM (`"type": "module"` in package.json).
- Campaign test mocks at `{ items: page }` in `orchestration.test.ts` are mocking the **Audience Engine**'s segment fetch, not the campaign list endpoint — leave them unchanged.
- Referral test file `public-routes.test.ts` asserts `body.referrals` — this is the portal-facing public referral list, not the internal list endpoint. Leave unchanged.
- Import and Import rows endpoints already use `data` key — no changes required.
- Email service `page`/`page_size` query params are unchanged; only removed from the response body.
- Notification `X-Total-Count` header (carries `totalUnread` count) is not part of the body standard — leave it unchanged.
