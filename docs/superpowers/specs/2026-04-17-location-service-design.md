# Location Management Design

**Date:** 2026-04-17
**Status:** Approved
**Service:** platform/identity

---

## 1. Overview

Locations are the 34 physical orthodontic practice sites. Every lead must belong to a location, every user is assigned to one or more locations, and JWTs carry a `locations[]` claim. Until now there was no master `locations` table — UUIDs were stored as unvalidated strings. This spec adds a first-class locations entity with CRUD API, gateway proxy, and CLI commands.

---

## 2. Data Model

New migration `003_create_locations.ts` in `apps/platform/identity/migrations/`.

### `platform_identity.locations`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, `gen_random_uuid()` |
| `name` | varchar | not null |
| `phone` | varchar | not null |
| `address` | varchar | not null (single text field) |
| `timezone` | varchar | not null (IANA tz, e.g. `America/New_York`) |
| `status` | varchar | not null, default `active`, check `active | inactive` |
| `created_at` | timestamptz | not null, default `now()` |
| `updated_at` | timestamptz | not null, default `now()` |

Indexes: `status`, `name`.

### FK from `user_locations`

`user_locations.location_id` gains a FK reference to `platform_identity.locations.id` with `ON DELETE RESTRICT`. This prevents removing a location that still has users assigned.

### Cross-service references

`crm_leads.leads.location_id` and all other cross-schema `location_id` columns remain plain UUIDs per the golden rule (no cross-service DB reads). Validation of those IDs is left to API-layer checks in the respective services.

---

## 3. API — Identity Service

All routes registered in a new `src/routes/locations.ts` file and mounted in `src/index.ts`.

### Access control

- **Read** (`GET`): any authenticated caller (JWT or API key)
- **Write** (`POST`, `PATCH`, `DELETE`): `super_admin` role only, enforced via `requireRole(['super_admin'])` preHandler

### Endpoints

#### `GET /identity/locations`

List all locations.

Query params:
- `status` (optional): `active | inactive` — filters by status. Omit to return all.

Response `200`:
```json
{
  "locations": [
    { "id": "uuid", "name": "Downtown Ortho", "phone": "+15551234567", "address": "123 Main St, New York, NY 10001", "timezone": "America/New_York", "status": "active" }
  ]
}
```

No pagination — maximum 34 locations, fits in a single response.

#### `GET /identity/locations/:id`

Returns full location object. `404` if not found.

#### `POST /identity/locations`

Create a location. Body:
```json
{ "name": "string", "phone": "string", "address": "string", "timezone": "string" }
```

Response `201` with full location object.

#### `PATCH /identity/locations/:id`

Partial update. Any subset of: `name`, `phone`, `address`, `timezone`, `status`. `404` if not found.

Response `200` with updated location object.

#### `DELETE /identity/locations/:id`

Soft-delete: sets `status = 'inactive'`. No hard delete.

Returns `204`. `404` if not found.

---

## 4. Repository & Service

New `src/repositories/location.repo.ts` with typed functions:
- `findAll(pool, status?)` 
- `findById(pool, id)`
- `create(pool, data)`
- `update(pool, id, data)`
- `softDelete(pool, id)`

No separate service layer — logic is simple enough to live in the route handlers directly (same pattern as the session routes).

---

## 5. Gateway Proxy

New route file `apps/crm/api-gateway/src/routes/locations.ts`. Registered with prefix `/v1/locations`, proxies to `IDENTITY_SERVICE_URL`. Uses the same `['/', '/*']` dual-registration pattern as all other proxy routes.

`IDENTITY_SERVICE_URL` is already in `config.ts` — no new env var needed.

---

## 6. CRM CLI

New command file `tools/crm-cli/src/commands/locations.ts`, registered in `src/index.ts`.

### Commands

| Command | Description |
|---|---|
| `crm locations list` | Table output: id (truncated), name, phone, timezone, status |
| `crm locations get <id>` | Key-value output: all fields |
| `crm locations create` | Interactive prompts for all fields, POST to `/locations` |
| `crm locations update <id>` | Interactive prompts pre-filled with current values, PATCH |
| `crm locations deactivate <id>` | Confirms, then PATCH `{ status: 'inactive' }` |

### Prompts for create / update

- Name (required)
- Phone (required)
- Address (required)
- Timezone (required, free-text IANA string)
- Status (required for update only — select `active | inactive`)

`deactivate` is a dedicated command rather than exposing `status` in `update` to make the destructive intent explicit and avoid accidental deactivation.

---

## 7. Error Handling

| Scenario | Response |
|---|---|
| Location not found | `404 { error: 'not_found' }` |
| Non-super_admin writes | `403` from `requireRole` preHandler |
| `DELETE` with assigned users | `409 { error: 'location_has_users' }` (FK violation caught and mapped) |
| Invalid status value | `400` from TypeBox schema validation |

---

## 8. Testing

- **Unit:** repository functions with mocked Knex, route handlers with mocked repo
- **Integration:** full lifecycle — create → list → get → update → deactivate; `DELETE` with assigned user returns `409`
