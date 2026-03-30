# Template Service — Design Spec (Updated)

**Date:** 2026-03-30
**Status:** Approved
**Supersedes:** `2026-03-25-template-service-design.md`
**Scope:** Platform-layer Template Service — backend service only (`apps/platform/template`). `@platform/template-ui` React component package is **out of scope** for this implementation pass.

---

## 1. Overview

The Template Service (`apps/platform/template`) is a **platform-layer service** that stores message templates and resolves merge tags at render time. It is fully domain-agnostic — it has no knowledge of leads, locations, pipelines, or coordinators.

**Core responsibilities:**
- Store templates for two channels: **SMS** (plain text) and **Email** (HTML + plain-text fallback)
- Render templates on demand: resolve `{{merge_tag}}` tokens against a caller-supplied `context` object
- Persist Unlayer JSON alongside exported HTML so templates remain re-editable in the browser
- Draft/active versioning: editing a live template creates a new draft without touching the active content
- Expose CRUD + render REST API

**Out of scope (this pass):**
- `@platform/template-ui` React component package (separate task)
- A/B variant selection (Campaign Service's responsibility)
- Location-scoped template overrides (handled via merge tags in caller-supplied context)
- Scheduling or delivery (Nurturing Engine, Messaging Service, Email Service)
- Template version history beyond the current draft and active version
- `POST /templates/:id/discard-draft` — not in v1

---

## 2. Architecture

```
Automation Engine / Nurturing Engine / Campaign Service
        │
        ▼  POST /templates/render
┌────────────────────────────────────────┐
│           Template Service             │
│   apps/platform/template               │
│                                        │
│  REST API                              │
│    ├── CRUD routes    (templates)      │
│    └── render route   (/render)        │
│                                        │
│  Template Renderer  (pure function)    │
│    └── merge tag resolution            │
│                                        │
│  Template Cache  (lru-cache, 30s TTL)  │
│    └── active_version content          │
│                                        │
│  Repository  (platform_templates DB)   │
└────────────────────────────────────────┘
        │
        ▼  rendered body (body_text / body_html)
Messaging Service / Email Service
```

**Call chain for SMS sending:** Automation Engine `send_message` worker and Nurturing Engine step worker both call `POST /templates/render` first, receive the rendered `body_text`, then call `POST /messages/send` on the Messaging Service with the pre-rendered `body` field. The Messaging Service never calls the Template Service.

**No events published.** The Template Service is purely request/response — it makes no calls to other services and publishes no EventBridge events.

**No Redis, no BullMQ.** Stateless render service. The only runtime dependencies beyond PostgreSQL are the in-process `lru-cache` instance and `@ortho/auth-middleware`.

---

## 3. Data Model — `platform_templates`

Two-table versioning pattern consistent with the Automation Engine and Nurturing Engine.

```sql
-- Template group: name, channel, status, active version pointer
templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,                      -- globally unique display label
  channel         text NOT NULL,                             -- 'sms' | 'email'
  status          text NOT NULL DEFAULT 'draft',             -- draft | active | disabled
  active_version  integer,                                   -- NULL until first activation
  current_version integer NOT NULL DEFAULT 1,                -- latest draft version number
  created_by      uuid,                                      -- JWT sub claim if present; NULL otherwise
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
)

-- One row per version of a template definition
template_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid REFERENCES templates(id) NOT NULL,
  version         integer NOT NULL,

  -- SMS and email plain-text fields
  body_text       text,            -- plain text with {{merge_tags}} (required for SMS; plain-text fallback for email)

  -- Email-only fields
  subject         text,            -- email subject with {{merge_tags}}
  body_html       text,            -- pre-rendered Unlayer HTML with {{merge_tags}}
  body_unlayer    jsonb,           -- Unlayer JSON design schema (browser re-editing only)

  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
)
```

### 3.1 Channel field usage

| Channel | `body_text` | `subject` | `body_html` | `body_unlayer` |
|---------|-------------|-----------|-------------|----------------|
| `sms`   | required    | —         | —           | —              |
| `email` | required (plain-text fallback) | required | required | required |

### 3.2 Active vs draft

`active_version` is the version all callers render against. `current_version` is the draft under edit. Both can differ simultaneously. Editing an active template increments `current_version` and inserts a new `template_versions` row; `active_version` remains unchanged until a Marketing Manager explicitly activates.

### 3.3 Content length limits (soft — enforced at the API layer, not DB)

| Field | Limit |
|-------|-------|
| `name` | 255 chars |
| `body_text` (SMS) | 1 600 chars (10 × 160-char segments) |
| `body_text` (email plain-text fallback) | 10 000 chars |
| `subject` | 500 chars |
| `body_html` | 500 000 chars |
| `body_unlayer` | validated as parseable JSON object; no explicit size cap |

Requests exceeding limits are rejected with `400 { error: "..." }`.

---

## 4. API

All endpoints require **at least Marketing Staff** role. Manager-only actions (`activate`, `disable`, `enable`) additionally require the `marketing_manager` role enforced via `requireRole('marketing_manager')` from `@ortho/auth-middleware`. Auth is enforced on every route — unauthenticated requests receive `401`.

### 4.1 Template CRUD

```
POST   /templates              — create template
GET    /templates              — list (paginated, filterable, sortable)
GET    /templates/:id          — get group row + draft content + active content
PATCH  /templates/:id          — update draft content
POST   /templates/:id/activate — promote current_version → active_version  [Manager only]
POST   /templates/:id/disable  — set status = disabled                      [Manager only]
POST   /templates/:id/enable   — re-enable a disabled template              [Manager only]
```

#### POST /templates

Request:
```json
{ "name": "Welcome SMS", "channel": "sms" }
```

Response `201`:
```json
{
  "id": "uuid",
  "name": "Welcome SMS",
  "channel": "sms",
  "status": "draft",
  "current_version": 1,
  "active_version": null,
  "created_by": "uuid-or-null",
  "created_at": "iso",
  "updated_at": "iso"
}
```

Errors:
- `409 { "error": "Template name already exists" }` — `UNIQUE(name)` violation
- `400 { "error": "..." }` — missing required fields or invalid channel

#### GET /templates

Query parameters:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `channel` | `sms \| email` | — | Filter by channel |
| `status` | `draft \| active \| disabled` | — | Filter by status |
| `sort` | `created_at \| updated_at` | `updated_at` | Sort field |
| `order` | `asc \| desc` | `desc` | Sort direction |
| `limit` | integer 1–100 | `20` | Page size |
| `offset` | integer ≥ 0 | `0` | Page offset |

Response `200`:
```json
{
  "data": [ { ...template rows without version content... } ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

#### GET /templates/:id

Returns the group row plus the `current_version` content and, if one exists, the `active_version` content separately.

Response `200`:
```json
{
  "id": "uuid",
  "name": "Welcome SMS",
  "channel": "sms",
  "status": "active",
  "current_version": 3,
  "active_version": 2,
  "created_by": "uuid",
  "created_at": "iso",
  "updated_at": "iso",
  "draft_content": {
    "version": 3,
    "body_text": "Hi {{first_name}}! Draft copy."
  },
  "active_content": {
    "version": 2,
    "body_text": "Hi {{first_name}}! Live copy."
  }
}
```

`active_content` is `null` when `active_version IS NULL`.

Errors:
- `404 { "error": "Not found" }`

#### PATCH /templates/:id

Updates draft content. Channel is immutable. Fields belonging to the other channel are silently ignored (not stored, no error). Disabled templates can still have their draft edited — the patch does not auto re-enable.

Request (all fields optional):
```json
{
  "name": "...",
  "body_text": "...",
  "subject": "...",
  "body_html": "...",
  "body_unlayer": {}
}
```

**Versioning behavior:**
- `active_version IS NULL` — update `current_version` row in-place; `current_version` unchanged.
- `current_version = active_version` — create new row at `current_version + 1`; increment `templates.current_version`; `active_version` unchanged.
- `current_version > active_version` — update existing `current_version` row in-place.

Response `200`: updated group row + `draft_content`.

Errors:
- `404 { "error": "Not found" }`
- `400 { "error": "..." }` — content limit exceeded

#### POST /templates/:id/activate

Promotes `current_version` → `active_version`; sets `status = active`. Evicts cache entry for this template (does not pre-warm — first render after eviction fetches from DB and populates cache).

Response `200`: updated group row.

Errors:
- `404 { "error": "Not found" }`
- `403 { "error": "Forbidden" }` — insufficient role

#### POST /templates/:id/disable

Sets `status = disabled`. Eagerly evicts cache entry (renders return `404` immediately after this call, not waiting for TTL expiry).

If called on a `draft` template (never activated, `active_version IS NULL`): succeeds but includes a warning field in the response — `"warning": "Template has no active version; it was never activated"`.

Response `200`:
```json
{
  ...group row,
  "warning": "Template has no active version; it was never activated"  // only present when disabling a draft
}
```

Errors:
- `404 { "error": "Not found" }`
- `400 { "error": "Template is already disabled" }` — already disabled
- `403 { "error": "Forbidden" }` — insufficient role

#### POST /templates/:id/enable

Re-enables a disabled template; sets `status = active`. Relies on TTL expiry for cache propagation (no eager warm or evict).

Response `200`: updated group row.

Errors:
- `404 { "error": "Not found" }`
- `400 { "error": "Template has no active version" }` — `active_version IS NULL`
- `400 { "error": "Template is not disabled" }` — template is not in `disabled` state
- `403 { "error": "Forbidden" }` — insufficient role

### 4.2 Render

```
POST /templates/render
```

Does **not** require Marketing Staff or Manager role — service-to-service callers (Automation Engine, Nurturing Engine, Campaign Service) use API key auth, not user JWT. Route requires a valid Identity Service token (user JWT or service API key) but no specific user role.

Request:
```json
{
  "template_id": "uuid",
  "context": {
    "first_name": "Sarah",
    "location_name": "Ortho North",
    "referral_link": "https://example.com/ref/abc123",
    "lead": {
      "treatment_interest": "Invisalign"
    }
  }
}
```

Response — email `200`:
```json
{
  "channel": "email",
  "subject": "Sarah, your free exam at Ortho North is waiting",
  "body_html": "<html>...</html>",
  "body_text": "Sarah, your free exam at Ortho North is waiting..."
}
```

Response — SMS `200`:
```json
{
  "channel": "sms",
  "body_text": "Hi Sarah! Book your free exam at Ortho North: https://example.com/ref/abc123"
}
```

**Render error responses:**
- `404 { "error": "Template not found or not renderable" }` — `active_version IS NULL` or `status = disabled`
- `400 { "error": "..." }` — missing `template_id`, non-UUID `template_id`, missing `context`, `context` is not an object, or malformed merge tag syntax detected in stored template (unclosed `{{`)

---

## 5. Rendering Engine

The render pipeline is a **pure function** — no I/O beyond the initial DB load.

```
POST /templates/render
  → validate request shape (template_id is UUID, context is object)
  → check lru-cache for template_id (30s TTL)
      HIT  → use cached active_version content
      MISS → SELECT template_versions WHERE template_id = ? AND version = templates.active_version
           → cache result
  → validate no malformed merge tags in stored content (unclosed {{ )
  → resolve merge tags in subject + body_html + body_text
  → return resolved fields
```

### 5.1 Merge tag resolution rules

- **Syntax:** `{{key}}` — consistent with the Messaging Service inline renderer
- **Dot-notation paths:** supported — `{{lead.first_name}}`, `{{location.name}}`
- **Array indexing:** not supported in v1 — object property paths only
- **Case-insensitive matching:** both the tag key and context keys are lowercased before matching. `{{First_Name}}` resolves against context key `first_name`.
- **Unknown key** (not present in context): replaced with empty string; warning logged to Datadog
- **Malformed syntax** (unclosed `{{` or `{{ }}` empty tag): render returns `400 { "error": "Malformed merge tag in template content" }` — these should have been caught at save time
- Context is the raw object supplied by the caller — Template Service never fetches additional data
- Rendering is synchronous and in-memory

### 5.2 Caching

- Implementation: `lru-cache` npm package (no Redis, no BullMQ)
- 30-second TTL per cache entry
- Cache key: `template:{id}:active`
- **Disable** → eagerly evicts the cache entry for that `template_id`. Renders return `404` immediately.
- **Activate** → evicts old cache entry only; does not pre-warm. The next render after activation fetches from DB and populates the cache.
- **Enable** → neither evicts nor warms; relies on TTL expiry (delayed effect is not safety-critical for enable).

---

## 6. Auth & RBAC

Implemented using `@ortho/auth-middleware`:

- All routes require a valid Identity Service JWT (or service API key for the render endpoint).
- All CRUD routes require **at least** Marketing Staff role — enforced by the `requireRole('marketing_staff')` middleware applied at the plugin level.
- `POST /templates/:id/activate`, `POST /templates/:id/disable`, `POST /templates/:id/enable` additionally require Marketing Manager role — enforced by a `requireRole('marketing_manager')` guard applied per route.
- `POST /templates/render` requires a valid auth token but no specific user role (service-to-service callers use API key auth).

| Endpoint group | Required role |
|---|---|
| All CRUD routes | `marketing_staff` (minimum) |
| activate / disable / enable | `marketing_manager` |
| render | authenticated (any valid token) |

---

## 7. Error Response Shape

Consistent with the Automation Engine and Notification Service conventions:

| Scenario | Shape |
|---|---|
| Single error (400, 403, 404, 409) | `{ "error": "Human-readable message" }` |
| Validation errors (422) | `{ "errors": ["field: message", ...] }` |

Fastify schema validation failures (malformed request body, missing required fields) return `400` with Fastify's built-in format, which is then normalised by an `onError` hook to `{ "error": "..." }`.

---

## 8. Infrastructure & Service Layout

```
apps/platform/template/
├── src/
│   ├── routes/
│   │   ├── templates.ts          # CRUD routes (create, list, get, patch, activate, disable, enable)
│   │   └── render.ts             # POST /templates/render
│   ├── services/
│   │   ├── template-renderer.ts  # pure merge tag resolution — no I/O
│   │   └── template-cache.ts     # lru-cache wrapper, 30s TTL
│   ├── repositories/
│   │   └── templates.ts          # DB access (platform_templates schema only)
│   └── index.ts
├── migrations/
│   ├── 001_create_templates.ts
│   └── 002_create_template_versions.ts
├── test/
│   ├── unit/
│   │   ├── template-renderer.test.ts
│   │   └── template-cache.test.ts
│   ├── integration/
│   │   ├── templates-crud.test.ts
│   │   └── render.test.ts
│   └── contract/
│       └── render-contract.test.ts
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `platform_templates` schema)
- `lru-cache` npm package
- `@ortho/auth-middleware` (JWT decode + RBAC)
- No Redis, no BullMQ, no EventBridge

---

## 9. Testing Strategy

### 9.1 Unit Tests (Vitest)

Pure function coverage — no external dependencies:

**Merge tag renderer (`template-renderer.ts`):**
- Happy path: all tags present in context
- Dot-notation path resolution: `{{lead.first_name}}`
- Missing key → empty string, no throw
- Nested context objects resolved correctly
- No merge tags in template → passthrough unchanged
- Multiple occurrences of same tag all replaced
- Case-insensitive matching: `{{First_Name}}` resolves `first_name` from context
- Malformed tag `{{` unclosed → returns error result (not throws)
- Empty tag `{{ }}` → returns error result
- Array index path (`{{appointments.0.date}}`) treated as unknown key → empty string (object paths only)

**Template cache (`template-cache.ts`):**
- Cache hit returns stored content without DB call
- Cache miss triggers DB fetch and stores result
- TTL expiry triggers re-fetch on next request
- Evict removes the entry; next access is a miss

### 9.2 Integration Tests (Vitest + real Postgres)

Test DB setup: run migrations against a dedicated test database at the start of the integration test suite (same pattern as Automation Engine / Nurturing Engine). No Docker Compose — assumes `TEST_DATABASE_URL` env var points to a pre-existing test database.

**Render (`render.ts`):**
- Active SMS template → renders, response contains only `body_text`
- Active email template → renders, response contains `subject`, `body_html`, `body_text`
- Template with `active_version IS NULL` → 404
- Template with `status = disabled` → 404
- `PATCH` → `POST activate` → render returns new content
- Edit draft while active version exists → render returns old active content until activation
- Activate → render immediately after → returns old content (cache TTL not yet expired); after TTL expiry → returns new content
- `POST disable` → render immediately after → 404 (eager cache eviction)
- `POST enable` → subsequent render returns content again (within TTL window, after TTL)
- `POST enable` on template with no `active_version` → 400
- Render with missing context keys → body contains empty strings for those tags
- Render with malformed merge tag in stored content → 400

**CRUD (`templates-crud.ts`):**
- `POST /templates` creates template with `status: draft`, `current_version: 1`, `active_version: null`
- `POST /templates` with duplicate name → 409
- `GET /templates` returns paginated list; `total` reflects actual count
- `GET /templates?channel=sms` returns only SMS templates
- `GET /templates?status=active` returns only active templates
- `GET /templates?sort=created_at&order=asc` returns in ascending creation order
- `GET /templates/:id` returns group row + `draft_content` + `active_content` (null when never activated)
- `PATCH` on never-activated template → updates version row in-place, `current_version` unchanged
- `PATCH` on active template (no pending draft) → creates new version row, `current_version` increments, `active_version` unchanged
- `PATCH` on draft already in progress → updates existing draft row in-place
- `PATCH` with email-only fields on SMS template → fields silently ignored, no error
- `PATCH` with SMS body_text exceeding 1 600 chars → 400
- `PATCH` on disabled template → allowed, does not auto re-enable
- `POST activate` increments `active_version` to match `current_version`, `status → active`
- `POST disable` on active template → `status = disabled`
- `POST disable` on draft (never activated) → succeeds with `warning` field in response
- `POST disable` on already-disabled template → 400
- `POST enable` on disabled template with `active_version` → `status → active`
- `POST enable` on non-disabled template → 400
- Marketing Staff cannot call activate/disable/enable → 403
- Marketing Manager can call activate/disable/enable → 200

### 9.3 Contract Tests

Separate Vitest test file (`test/contract/render-contract.test.ts`) that validates the `POST /templates/render` request and response shapes:

- Request schema: `template_id` is a UUID string, `context` is a non-null object
- Response schema (SMS): `{ channel: "sms", body_text: string }`
- Response schema (email): `{ channel: "email", subject: string, body_html: string, body_text: string }`
- Error schema: `{ error: string }`

No Pact — plain Vitest assertions against TypeBox schemas.

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| `name` uniqueness | Global `UNIQUE(name)` | Prevents confusion when callers reference templates by name in config; simple to enforce |
| Content length limits | Soft limits in API layer | SMS: 1 600 chars (10 segments max); email: generous but bounded to avoid runaway storage. Enforced in route handler validation, not DB constraint, for cleaner error messages |
| `created_by` population | Optional — from JWT `sub` if present | Service-to-service callers (render endpoint) have no user sub; don't block non-user callers |
| Disable on draft | Allowed with `warning` field | Prevents silent confusion; caller gets feedback without a hard error |
| PATCH on disabled | Allowed, no auto re-enable | Editing a disabled template is a normal workflow — a manager disables, staff fixes the copy, then a manager re-enables. Auto re-enable would bypass the approval flow |
| Pagination on GET /templates | offset/limit | Dataset is not expected to be huge but not artificially small either; offset pagination is simpler and consistent with other list endpoints in the platform |
| Sorting | `updated_at DESC` default | Most recently edited templates surface first — matches the expected UI workflow |
| Merge tag syntax | `{{key}}` | Consistent with Messaging Service inline renderer. One syntax across all channels |
| Merge tag case sensitivity | Case-insensitive (normalise to lowercase) | Prevents common template authoring errors where `{{First_Name}}` fails to resolve against `first_name` from context |
| Malformed merge tags | `400` error at render time | Malformed tags in stored content indicate a data quality issue; silent passthrough would produce garbled output |
| Array indexing | Not supported in v1 | No known use case requiring `{{appointments.0.date}}`; can be added later without breaking changes |
| Cache implementation | `lru-cache` (no Redis) | Keeps the service dependency-free beyond PostgreSQL. LRU eviction handles memory bounding. 30s TTL is the same trade-off as the Automation Engine rule cache |
| Activate cache behaviour | Evict only, no pre-warm | Consistent with Automation Engine. Next render is slightly slower once but avoids the complexity of eager cache warming and potential race conditions |
| Disable cache behaviour | Eager eviction | Safety-critical: a disabled template may have been disabled due to content errors; it should stop rendering as fast as possible |
| Auth on render | Token required, no role | Render is a service-to-service call; Automation/Nurturing/Campaign use API key auth. No role check needed on the render path |
| Error shape | `{ error }` / `{ errors }` | Consistent with Automation Engine and Notification Service |
| No events published | None | Template Service is purely request/response. No state changes require downstream reaction |
| Template storage format | Pre-rendered HTML + Unlayer JSON | Render is pure string substitution — no server-side Unlayer dependency at render time. Unlayer JSON retained for browser re-editing only |
| Render target | `active_version` only | Callers always get stable content. Draft edits never affect in-flight automations or sequences |
| Missing merge tags | Empty string + Datadog warning | Silent degradation — a missing `{{first_name}}` produces "Hi !" rather than a 500 error |
| No location overrides | Merge tags in caller context | Eliminates scope resolution complexity. If a location needs a different template body, the product layer references a separate template ID |
| A/B variants | Campaign Service's responsibility | Template Service stores one body per template. Variant selection belongs with the caller |
| Versioning | Two-table (group + versions), draft/active | Safe to edit templates referenced by live rules without disrupting in-flight executions. Consistent with Automation Engine and Nurturing Engine |
