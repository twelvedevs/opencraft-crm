# ADR: Unified List Response Standard

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Andrey Pankov

---

## Context

As of April 2026, the monorepo has 19 collection endpoints across 10 services. They use 7 different response shapes:

| Shape | Services |
|-------|----------|
| `{ leads, nextCursor }` | Lead |
| `{ items, nextCursor }` | Referral (×3) |
| `{ items, total }` | Campaign, Audience |
| `{ rows, nextCursor }` | Pipeline |
| `{ rows, total }` | Conversation, Template |
| `{ data, nextCursor }` | Import, Messaging |
| `{ recipients, total, page, page_size }` | Email |
| bare array | Lead appointments |

There are no shared TypeScript types for pagination. Every consumer must know the specific key for each endpoint. This creates friction for the frontend, breaks API predictability, and makes it impossible to write generic data-fetching utilities.

## Decision

All collection endpoints return a single standard envelope:

```typescript
{
  data: T[];
  nextCursor?: string | null;
  total?: number;
}
```

### Rules

**`data`** is always present. It is the only collection key.

**`nextCursor`** is present on cursor-based endpoints. `null` means no more pages. Absent on offset-based endpoints.

**`total`** is always present on offset-based endpoints. On cursor-based endpoints it is absent by default; endpoints may optionally support `?include_total=true` which adds a `COUNT(*)` query and returns `total`.

**Pagination parameters** (`cursor`, `limit`, `offset`, `page`) are not part of this ADR — each service keeps its existing query parameters unchanged.

**camelCase** is used for `nextCursor` (not `next_cursor`). This aligns with the rest of the API.

### Rejected alternatives

**`{ items, nextCursor }`** — Semantic keys (`items`, `leads`, `rows`) are more readable in isolation but require every consumer to hardcode the key per endpoint. Rejected.

**Cursor-only (no offset)** — Would require rewriting Campaign, Conversation, Audience, and Email repositories. These are bounded collections where `total` is needed for UI (e.g., "87 campaigns"). Offset pagination is appropriate here. Rejected.

**`{ data, meta: { nextCursor, total } }` (JSON:API style)** — More structured, but adds nesting that provides no practical benefit for this codebase size. Rejected.

### Exception: Import rows integer cursor

`GET /imports/:id/rows` returns `{ data: ImportRow[], nextCursor: number | null }` where `nextCursor` is the `row_number` of the last returned row (an integer).

**Rationale:** CSV import rows are indexed by a stable sequential integer. Using a base64-encoded cursor would add encoding/decoding overhead with no benefit — the row_number is already a natural, collision-free cursor. This endpoint is internal-facing and not part of the public API surface.

## Consequences

### Positive
- Single response shape across all list endpoints — frontend can write one generic hook
- Shared `PaginatedResponse<T>` type in `@ortho/types` — type safety across services
- New services default to the standard — no decision to make
- QA scenarios for migrated endpoints assert on `["data"]` + the expected pagination key (`nextCursor` or `total`)

### Negative
- 17 endpoints require response shape changes (rename key in route handler + update TypeBox schema + update tests)
- Services using `next_cursor` (Messaging, Identity, Notification) need field rename
- Email service loses `page` / `page_size` from response body (still available as query params)

### Neutral
- Import and Import rows endpoints already use `data` key — no change needed
- Internal pagination mechanisms (cursor encoding, offset logic) are unchanged

## Rollout

**This is a breaking API change.** Services that call each other's list endpoints must be coordinated:

- Lead Service `GET /leads` is consumed by: `apps/crm/conversation/src/services/bulk-sender.ts`, `apps/crm/campaign/src/services/audience-resolver.ts`, `tools/crm-cli`
- Conversation `GET /conversations` is consumed by: `tools/crm-cli`
- Pipeline `GET /pipeline/memberships` is consumed by: `tools/crm-cli`

**Deploy order:** Consumers are updated in the same PR as producers (this branch). All services and tools ship together — no staged rollout is needed because there is no production traffic yet (pre-sale / pre-launch repo).

If this migration were done post-launch, the required order would be: deploy updated consumers first (parsing both old and new shapes with a shim), then deploy producers, then remove the shim.

## Out of scope (pending follow-up)

The following collection endpoints remain on per-service shapes and are **not** covered by this ADR. They will be migrated in a follow-up initiative:

- `GET /rules` and `GET /executions` — Automation Engine (both have TypeBox `Type.Array(...)` response schemas that also need updating)
- `GET /sequences`, `GET /sequences/:id/enrollments` — Nurturing Engine
- `GET /conversations/:id/messages` — Conversation Service (uses `{ messages, hasMore }`, message-pagination is distinct from conversation-list pagination)
- `GET /conversations/:id/scheduled-messages` — Conversation Service

These endpoints work correctly against their current clients. Adoption of the standard is incremental.
