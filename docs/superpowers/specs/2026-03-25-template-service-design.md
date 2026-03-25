# Template Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Platform-layer Template Service — template storage, draft/active versioning, merge tag rendering, `@platform/template-ui` React component (Unlayer email editor + SMS editor)

---

## 1. Overview

The Template Service (`apps/platform/template`) is a **platform-layer service** that stores message templates and resolves merge tags at render time. It is fully domain-agnostic — it has no knowledge of leads, locations, pipelines, or coordinators.

**Core responsibilities:**
- Store templates for two channels: **SMS** (plain text) and **Email** (HTML + plain-text fallback)
- Render templates on demand: resolve `{{merge_tag}}` tokens against a caller-supplied `context` object
- Persist Unlayer JSON alongside exported HTML so templates remain re-editable in the browser
- Draft/active versioning: editing a live template creates a new draft without touching the active content
- Expose CRUD + render REST API
- Ship `@platform/template-ui` React component — Unlayer email editor, SMS text editor, template library browser

**Out of scope:**
- A/B variant selection (Campaign Service's responsibility)
- Location-scoped template overrides (handled via merge tags in caller-supplied context)
- Scheduling or delivery (Nurturing Engine, Messaging Service, Email Service)
- Template version history beyond the current draft and active version

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
│  Template Cache  (in-memory, 30s TTL)  │
│    └── active_version content          │
│                                        │
│  Repository  (platform_templates DB)   │
└────────────────────────────────────────┘
```

**No events published.** The Template Service is purely request/response — it makes no calls to other services and publishes no EventBridge events.

**No Redis, no BullMQ.** Stateless render service. The only runtime dependency beyond PostgreSQL is the in-process in-memory cache.

---

## 3. Data Model — `platform_templates`

Two-table versioning pattern consistent with the Automation Engine and Nurturing Engine.

```sql
-- Template group: name, channel, status, active version pointer
templates (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  channel         text NOT NULL,                   -- 'sms' | 'email'
  status          text NOT NULL DEFAULT 'draft',   -- draft | active | disabled
  active_version  integer,                         -- NULL until first activation
  current_version integer NOT NULL DEFAULT 1,      -- latest draft version number
  created_by      uuid,
  created_at      timestamptz,
  updated_at      timestamptz
)

-- One row per version of a template definition
template_versions (
  id              uuid PRIMARY KEY,
  template_id     uuid REFERENCES templates NOT NULL,
  version         integer NOT NULL,

  -- SMS and email plain-text fields
  body_text       text,            -- plain text with {{merge_tags}}

  -- Email-only fields
  subject         text,            -- email subject line with {{merge_tags}}
  body_html       text,            -- pre-rendered HTML exported from Unlayer, with {{merge_tags}}
  body_unlayer    jsonb,           -- Unlayer JSON design schema (for re-editing in browser only)

  created_by      uuid,
  created_at      timestamptz,
  UNIQUE (template_id, version)
)
```

**Channel field usage:**

| Channel | `body_text` | `subject` | `body_html` | `body_unlayer` |
|---------|-------------|-----------|-------------|----------------|
| `sms`   | ✓           | —         | —           | —              |
| `email` | ✓ (plain-text fallback) | ✓ | ✓      | ✓              |

**Active vs draft:** `active_version` is the version all callers render against. `current_version` is the draft under edit. Both can differ simultaneously — the same pattern as the Automation Engine. Editing an active template increments `current_version` and inserts a new `template_versions` row; `active_version` remains unchanged until a manager explicitly activates.

---

## 4. API

### 4.1 Template CRUD

```
POST   /templates              — create template (name, channel)
GET    /templates              — list all (name, channel, status, current_version, active_version)
GET    /templates/:id          — get group row + active version content
PATCH  /templates/:id          — update draft content (name, body_text, subject, body_html, body_unlayer)
POST   /templates/:id/activate — promote current_version → active_version; status → active
POST   /templates/:id/disable  — set status = disabled
```

**Activation rules:**
- `POST /templates/:id/activate` only available to Marketing Managers (enforced via Identity Service JWT RBAC)
- Marketing Staff can `PATCH` (edit drafts) but cannot activate or disable

### 4.2 Render

```
POST /templates/render
```

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

Response — email:
```json
{
  "channel": "email",
  "subject": "Sarah, your free exam at Ortho North is waiting",
  "body_html": "<html>...</html>",
  "body_text": "Sarah, your free exam at Ortho North is waiting..."
}
```

Response — SMS:
```json
{
  "channel": "sms",
  "body_text": "Hi Sarah! Book your free exam at Ortho North: https://example.com/ref/abc123"
}
```

**Render error responses:**
- `404` — template not found, has no `active_version`, or is `disabled`
- `400` — malformed request (missing `template_id` or `context`)

---

## 5. Rendering Engine

The render pipeline is a **pure function** — no I/O beyond the initial DB load.

```
POST /templates/render
  → check in-memory cache for template_id (30s TTL)
      HIT  → use cached active_version content
      MISS → SELECT template_versions WHERE template_id = ? AND version = templates.active_version
  → resolve merge tags in subject + body_html + body_text
  → return resolved fields
```

**Merge tag resolution rules:**
- Syntax: `{{key}}` — consistent with the Messaging Service inline renderer
- Dot-notation paths supported: `{{lead.first_name}}`, `{{location.name}}`
- Unknown key (not present in context) → replaced with empty string; warning logged to Datadog
- Context is the raw object supplied by the caller — Template Service never fetches additional data
- Rendering is synchronous and in-memory

**Caching:**
- In-memory cache per instance, 30s TTL
- Cache key: `template:{id}:active`
- Invalidation is TTL-based only — activation takes effect within 30 seconds across all running instances (same pattern as Automation Engine rule cache)

---

## 6. `@platform/template-ui` React Component

Exported from `packages/@platform/template-ui`. Calls the Template Service API directly from the browser — not proxied through the CRM API Gateway. Auth enforced via the same Identity Service JWT token the CRM shell holds.

### Views

**Template Library**
Table of all templates: name, channel badge (SMS / Email), status (Draft / Active / Disabled), last updated timestamp. Filterable by channel and status. Click any row to open the editor.

**Email Editor**
Embeds Unlayer (`react-email-editor`):
- On load: initializes Unlayer with stored `body_unlayer` JSON, or a blank canvas for new templates
- On save: calls Unlayer's `exportHtml()` → `PATCH /templates/:id` with both `body_html` and `body_unlayer`
- Subject line input above the canvas — plain text, supports `{{merge_tag}}` syntax
- Plain-text fallback field below the canvas — auto-stripped from HTML on first export, manually editable
- **Activate** button (Marketing Manager only) — calls `POST /templates/:id/activate`
- **Disable** button (Marketing Manager only) — calls `POST /templates/:id/disable`

**SMS Editor**
Simple textarea:
- Plain text with `{{merge_tag}}` syntax
- Character count and SMS segment count (160 chars = 1 segment, displayed live)
- Merge tag helper: clickable list of common tags inserts `{{tag}}` at cursor position
- **Activate** button (Marketing Manager only)
- **Disable** button (Marketing Manager only)

### Role Enforcement

| Action | Marketing Staff | Marketing Manager |
|---|---|---|
| Create template | ✓ | ✓ |
| Edit draft content | ✓ | ✓ |
| Activate template | — | ✓ |
| Disable template | — | ✓ |

---

## 7. Infrastructure & Service Layout

```
apps/platform/template/
├── src/
│   ├── routes/
│   │   ├── templates.ts          # CRUD routes (create, list, get, patch, activate, disable)
│   │   └── render.ts             # POST /templates/render
│   ├── services/
│   │   ├── template-renderer.ts  # pure merge tag resolution — no I/O
│   │   └── template-cache.ts     # in-memory cache, 30s TTL
│   ├── repositories/
│   │   └── templates.ts          # DB access (platform_templates schema only)
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `platform_templates` schema)
- No Redis, no BullMQ, no EventBridge

---

## 8. Testing Strategy

### Unit Tests (Vitest)

Pure function coverage — no external dependencies:

- **Merge tag resolver:**
  - Happy path: all tags present in context
  - Dot-notation path resolution: `{{lead.first_name}}`
  - Missing key → empty string (no throw)
  - Nested context objects resolved correctly
  - No merge tags in template → passthrough unchanged
  - Multiple occurrences of same tag all replaced

- **Template cache:**
  - Cache hit returns stored content without DB call
  - Cache miss triggers DB fetch and stores result
  - TTL expiry triggers re-fetch on next request

### Integration Tests (Vitest + real Postgres)

- `POST /templates/render` — active version rendered, all merge tags resolved
- `POST /templates/render` — template has no `active_version` → 404
- `POST /templates/render` — template status is `disabled` → 404
- `PATCH /templates/:id` → `POST /templates/:id/activate` → render returns new content
- Edit draft while active version exists → render still returns old active content until activation
- SMS render: response contains only `body_text`, no `subject` or `body_html`
- Email render: response contains `subject`, `body_html`, and `body_text`
- Activate increments `active_version` to match `current_version`

### Contract Tests

- **Inbound:** `POST /templates/render` request shape validated — `template_id` is UUID, `context` is an object
- **Outbound:** none — Template Service makes no calls to other services

---

## 9. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Template storage format | Pre-rendered HTML + Unlayer JSON | Render is pure string substitution — no server-side Unlayer dependency at render time. Unlayer JSON retained for browser re-editing only. |
| Merge tag syntax | `{{key}}` | Consistent with Messaging Service inline renderer. One syntax across all channels. |
| Render target | `active_version` only | Callers always get stable content. Draft edits never affect in-flight automations or sequences. |
| Missing merge tags | Empty string + Datadog warning | Silent degradation — a missing `{{first_name}}` produces "Hi !" rather than a 500 error. |
| Caching | In-memory, 30s TTL | Same pattern as Automation Engine rule cache. Keeps render latency low with no Redis dependency. Activation takes effect within 30 seconds. |
| No events published | None | Template Service is purely request/response. No state changes require downstream reaction. |
| No location overrides | Merge tags in caller context | Eliminates scope resolution complexity. Callers supply all location-specific values in the context object. If a location needs a different template body, the product layer references a separate template ID. |
| A/B variants | Campaign Service's responsibility | Template Service stores one body per template. Variant selection and winner logic belong with the caller. |
| Versioning | Two-table (group + versions), draft/active | Consistent with Automation Engine and Nurturing Engine. Safe to edit templates referenced by live rules without disrupting in-flight executions. |
