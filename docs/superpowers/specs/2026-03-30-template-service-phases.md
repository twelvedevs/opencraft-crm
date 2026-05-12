# Template Service — Implementation Phases

**Date:** 2026-03-30
**Spec:** `2026-03-30-template-service-updated-design.md`
**Scope:** Backend only (`apps/platform/template`). `@platform/template-ui` is excluded.

---

## Phase 1 — Project Scaffold + Data Model

**Deliverables:**
- `apps/platform/template/` directory structure (per monorepo layout)
- `package.json`, `tsconfig.json`, `Dockerfile`
- Knex migrations: `001_create_templates.ts`, `002_create_template_versions.ts`
- Repository layer (`src/repositories/templates.ts`) — DB access for both tables; no business logic
- Fastify app entry point (`src/index.ts`) — server boots, health check route, DB connection established
- `@ortho/auth-middleware` wired; all routes protected

---

## Phase 2 — Template CRUD (Core)

**Deliverables:**
- `POST /templates` — create with `status: draft`, `current_version: 1`, `active_version: null`
- `GET /templates` — paginated list with `channel`, `status`, `sort`, `order`, `limit`, `offset` filters
- `GET /templates/:id` — group row + `draft_content` + `active_content`
- `PATCH /templates/:id` — update draft content with the three-branch versioning logic (in-place vs new draft version)
- Content-length validation (soft limits enforced in route handlers)
- Channel immutability enforced on `PATCH`; cross-channel fields silently ignored
- `marketing_staff` role guard applied at plugin level

---

## Phase 3 — Activation Lifecycle

**Deliverables:**
- `POST /templates/:id/activate` — promote `current_version` → `active_version`; `status = active`
- `POST /templates/:id/disable` — `status = disabled`; warning field when `active_version IS NULL`; `400` if already disabled
- `POST /templates/:id/enable` — re-enable; `400` if `active_version IS NULL`; `400` if not disabled
- `marketing_manager` role guard applied per route for activate / disable / enable
- Unit tests for versioning state transitions

---

## Phase 4 — Render Engine + Cache

**Deliverables:**
- `src/services/template-renderer.ts` — pure merge tag resolution function (`{{key}}`, dot-notation, case-insensitive, missing → empty string + log, malformed → error result)
- `src/services/template-cache.ts` — `lru-cache` wrapper; 30s TTL; keyed `template:{id}:active`; evict on disable/activate
- `POST /templates/render` route — validate request, cache lookup, resolve tags, return channel-appropriate response shape
- Render route auth: valid token required, no role check
- Eager cache eviction wired to `disable` and `activate` handlers
- Unit tests: renderer (all edge cases from spec §9.1) + cache (hit/miss/TTL/evict)

---

## Phase 5 — Integration + Contract Tests

**Deliverables:**
- `test/integration/templates-crud.test.ts` — full CRUD + lifecycle scenarios against real Postgres
- `test/integration/render.test.ts` — render happy paths, 404 cases, cache eviction/TTL behavior, missing merge tags, malformed tags
- `test/contract/render-contract.test.ts` — TypeBox schema assertions on request + response shapes (SMS, email, error)
- `npm run test` passes clean; `npm run typecheck` passes clean
