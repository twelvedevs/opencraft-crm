# List Response Standard — Design Spec

**Status:** Approved
**Date:** 2026-04-18
**Author:** Andrey Pankov

---

## Problem

Every service in the monorepo uses a different shape for collection endpoints:
`leads`, `items`, `rows`, `data`, `recipients`, bare arrays — 7 distinct patterns across 19 endpoints. There are no shared TypeScript types for pagination. This makes it impossible to write a generic client, increases onboarding friction, and will cause bugs when the frontend is built.

## Decision

All list/collection endpoints return:

```typescript
{
  data: T[];
  nextCursor?: string | null;   // cursor-based pagination only
  total?: number;               // offset-based always; cursor-based only with ?include_total=true
}
```

### Pagination modes

Two pagination modes are allowed. The wrapper shape is identical — only which optional fields are present differs.

**Cursor-based** — for large or append-only collections:
```
GET /leads?cursor=<token>&limit=50
→ { data: [...], nextCursor: "abc..." }   // more pages

GET /leads?cursor=<token>&limit=50&include_total=true
→ { data: [...], nextCursor: "abc...", total: 1247 }

GET /leads?cursor=<last_token>&limit=50
→ { data: [...], nextCursor: null }       // last page
```

**Offset-based** — for bounded or UI-paginated collections:
```
GET /campaigns?limit=20&offset=0
→ { data: [...], total: 87 }
```

Internal pagination parameters (`cursor`, `limit`, `offset`, `page`) are not changed — only the response wrapper is standardised.

### `include_total` on cursor endpoints

No cursor-based endpoint supports `include_total=true` in this migration. The flag is a defined extension point: future endpoints may opt in by executing a separate `COUNT(*)` query and returning `total` alongside `nextCursor`. Endpoints that do not support the flag ignore it and never return `total`.

### Documented exception

`GET /imports/:id/rows` uses an **integer** `nextCursor` (the `row_number` of the last returned row). This is a deliberate exception: row_number is a stable, naturally ordered integer key that is more efficient than a base64-encoded cursor for sequential row access. The `nextCursor` field for this endpoint is `number | null`.

All other cursor-based endpoints use an opaque base64-encoded string cursor.

---

## Shared Types

Add `packages/@ortho/types/src/pagination.ts`:

```typescript
export interface PaginatedResponse<T> {
  data: T[];
  nextCursor?: string | null;
  total?: number;
}

// Exception variant for import rows
export interface RowPaginatedResponse<T> {
  data: T[];
  nextCursor: number | null;
}
```

TypeBox schema (for Fastify route validation):

```typescript
import { Type, type TSchema } from '@sinclair/typebox';

export const PaginatedResponseSchema = <T extends TSchema>(itemSchema: T) =>
  Type.Object({
    data: Type.Array(itemSchema),
    nextCursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    total: Type.Optional(Type.Number()),
  });
```

Export from `packages/@ortho/types/src/index.ts`.

---

## Migration Table

All 19 affected endpoints. "Pagination" column = what the endpoint keeps internally.

| Service | Endpoint | Old collection key | Old pagination fields | Action |
|---------|----------|--------------------|-----------------------|--------|
| Lead | `GET /leads` | `leads` | `nextCursor` | rename key |
| Lead | `GET /leads/duplicates` | `leads` | `nextCursor` | rename key |
| Lead | `GET /leads/:id/appointments` | bare array | — | wrap in `{ data }` |
| Lead | `GET /leads/:id/activities` | `activities` | `nextCursor` | rename key |
| Campaign | `GET /campaigns` | `items` | `total` | rename key |
| Conversation | `GET /conversations` | `rows` | `total` | rename key |
| Pipeline | `GET /memberships` | `rows` | `nextCursor` | rename key |
| Referral | `GET /referrers` | `items` | `nextCursor` | rename key |
| Referral | `GET /referrals` | `items` | `nextCursor` | rename key |
| Referral | `GET /rewards` | `items` | `nextCursor` | rename key |
| Import | `GET /imports` | `data` | `nextCursor` | no change |
| Import | `GET /imports/:id/rows` | `data` | `nextCursor` (int) | no change — documented exception |
| Identity | `GET /users` | `users` | `next_cursor` | rename key, `next_cursor` → `nextCursor` |
| Identity | `GET /api-keys` | `keys` | — | rename key |
| Audience | `GET /segments` | `items` | `total` | rename key |
| Messaging | `GET /messages` | `data` | `next_cursor`, `has_more` | `next_cursor` → `nextCursor`, remove `has_more` |
| Email | `GET /campaigns/:id/recipients` | `recipients` | `total`, `page`, `page_size` | rename key, remove `page`/`page_size` |
| Template | `GET /templates` | `rows` | `total` | rename key |
| Notification | `GET /notifications` | `notifications` | `next_cursor` | rename key, `next_cursor` → `nextCursor` |

---

## Changes Required Per Service

For each service in the migration table:

1. **Route handler** — change `reply.send({ <old_key>: rows, ... })` to `reply.send({ data: rows, ... })`
2. **TypeBox response schema** — update to use `PaginatedResponseSchema` from `@ortho/types`
3. **Repository return type** — update TypeScript interface/type if it names the collection field
4. **Unit tests** — update any assertions on the old collection key
5. **Integration tests** — same

Additionally:
- `packages/@ortho/types` — add `pagination.ts`, export from `index.ts`
- `tools/qa/scenarios.yaml` — update all `body_contains` assertions for list endpoints to `["data"]`
- `docs/arch/adr-list-response-standard.md` — write ADR (see separate file)

---

## What Is Not Changed

- Internal pagination parameters (`cursor`, `limit`, `offset`, `page`) — untouched
- Non-list endpoints (single-resource GET, POST, PATCH, DELETE)
- Event payloads on EventBridge — unaffected
- Import rows integer cursor — documented exception, not normalised
- Email service `page` / `page_size` query params — kept; only removed from response body
