# Nurturing Engine — Implementation Phases

**Date:** 2026-03-30
**Spec:** `2026-03-30-nurturing-engine-updated-design.md`
**Scope:** Backend only — `@platform/sequence-ui` deferred per spec Section 7.

---

## Phase 1 — Shared Package Foundations

**Deliverables:**
- `packages/@ortho/interpolator` — new package created from scratch
  - `interpolateFields(template, context)` — dot-notation path resolver + `{{template_string}}` resolver
  - `computeNextActiveWindowMs(activeHours, timezone)` — active-hours calculator (next open window, always ≤ 24h, DST-safe)
- `packages/@ortho/types` amendments
  - `lead.outbound_sent` event type
  - `lead.activity_logged` event type
  - `unenroll_sequence` action type added to action type union
- Unit tests for `@ortho/interpolator` covering: dot-notation resolution, template strings, missing fields, nested objects, window boundary cases, DST edge cases

---

## Phase 2 — Service Scaffold + Database Schema

**Deliverables:**
- `apps/platform/nurturing/` directory structure per spec Section 9
- `package.json`, `tsconfig.json`, `Dockerfile`, `worker.ts` entry point
- Fastify app bootstrap (`src/index.ts`) — server setup, plugin registration stubs
- DB migration `001_initial_schema.ts` — all four tables with indexes:
  - `sequence_definitions`, `sequence_versions`, `sequence_enrollments`, `sequence_step_executions`
  - SQL comment block with bootstrap seed for "Contacted — No Response Follow-up" sequence
- Repository layer — typed Knex wrappers for all four tables:
  - `sequence-definitions.repo.ts`, `sequence-versions.repo.ts`, `enrollments.repo.ts`, `step-executions.repo.ts`

---

## Phase 3 — Sequence Management API

**Deliverables:**
- `src/routes/sequences.ts` — all sequence CRUD + lifecycle routes:
  - `GET /sequences` — list (name, status, version, step count)
  - `POST /sequences` — create sequence (inserts version 1 as draft)
  - `GET /sequences/:id` — detail with active + current version
  - `PUT /sequences/:id` — save draft (new version row, bumps `current_version`)
  - `POST /sequences/:id/activate` — sets `active_version = current_version` (`marketing_manager` only)
  - `POST /sequences/:id/disable` — sets `status = 'disabled'` (`marketing_manager` only)
- Versioning service logic (insert new version row on PUT, `active_version` unchanged until activate)
- Auth: JWT middleware, role checks on activate/disable
- Pagination: `limit` + cursor (keyset on `created_at`) on list endpoint
- Integration tests: CRUD lifecycle, versioning, role enforcement

---

## Phase 4 — Enrollment

**Deliverables:**
- `src/services/enrollment-manager.ts`:
  - Dedup check (`dedup_key` uniqueness → `200 OK` idempotent)
  - Sequence status validation (disabled → 422, draft → 422, not found → 404)
  - A/B variant assignment (`src/services/ab-assigner.ts` — weighted random pick)
  - Single DB transaction: insert enrollment row + all step execution rows with `scheduled_at = enrolled_at + delay`, `job_id = NULL`
  - Post-commit: enqueue BullMQ delayed job per step, write back `job_id`
- `src/routes/enrollments.ts` read endpoints:
  - `GET /sequences/:id/enrollments` — list with status, variant, enrolled_at (paginated)
  - `GET /sequences/:id/enrollments/:eid` — detail with all step statuses and outputs
  - `GET /sequences/:id/enrollments/:eid/steps/:sid/output` — retrieve AI draft or step result
- `POST /sequences/enroll` route (service-to-service; service JWT auth)
- Unit tests: `enrollment-manager` (correct `scheduled_at` per delay, step pre-insertion count, dedup paths); `ab-assigner` (50/50 converges over 10k samples, 0/100 deterministic)
- Integration tests: enroll → steps pre-inserted with correct `scheduled_at` and initial `job_id = NULL` → `job_id` updated; disabled sequence → 422; two concurrent enrollments with distinct `dedup_key` → both active; duplicate `dedup_key` → idempotent 200

---

## Phase 5 — Step Execution Engine

**Deliverables:**
- `src/services/step-worker.ts` — BullMQ worker:
  - Guard checks: enrollment status ≠ `active` → cancel step + ACK
  - Optimistic lock: `UPDATE ... WHERE status = 'pending' RETURNING id` → exit if no row
  - Load step definition from `sequence_versions` by `(sequence_id, sequence_version, step_id)`
  - Field interpolation via `@ortho/interpolator`
  - A/B variant override application
  - Active hours check: defer if outside window (update `scheduled_at`, clear + re-set `job_id`, re-enqueue)
  - Execute action → mark step `completed` → mark enrollment `completed` if last step
  - BullMQ retry: 5 total attempts, exponential backoff (5s → 30s → 2m → 10m) → step/enrollment `failed` on exhaustion
- `src/services/action-executor.ts` — dispatcher to action handlers
- `src/services/action-handlers/`:
  - `send-message.ts` — `POST /templates/render` then `POST /messages/send` with pre-rendered body + `dedup_key`
  - `send-email.ts` — `POST /templates/render` then `POST /emails/send` with pre-rendered subject + body
  - `call-ai.ts` — `POST /ai/complete` with `{ system_prompt, user_prompt, model }`; stores output; publishes `nurturing.step_output_ready` when `auto_send: false`; chains `send_message` when `auto_send: true`
  - `emit-event.ts` — payload field interpolation + `include_context` merge + EventBridge publish
- `src/events/publisher.ts` — publishes all `nurturing.*` events to EventBridge
- `worker.ts` entry point (separate ECS task definition, same Docker image)
- Unit tests: active hours deferral logic
- Integration tests: step fires inside window → `send_message` called with correct params; step fires outside window → deferred, fires at deferred time; all steps complete → enrollment `completed`, `nurturing.enrollment_completed` published; max retries → `failed`, `nurturing.step_failed` published; `call_ai` with `auto_send: false` → output stored, `nurturing.step_output_ready` published; `call_ai` with `auto_send: true` → `send_message` called; `emit_event` with `include_context: true` → context merged, explicit payload fields take precedence; A/B variant override params applied at execution; optimistic lock race → only first worker proceeds

---

## Phase 6 — Unenrollment + Opt-Out

**Deliverables:**
- `src/services/unenrollment.ts`:
  - Match by `(sequence_id, entity_type, entity_id, status='active')` — no `enrollment_id` required
  - Single transaction: set enrollment `unenrolled`, cancel all pending steps
  - Best-effort BullMQ `job.remove()` for cancelled steps
  - Publish `nurturing.enrollment_unenrolled`
  - Idempotent: `200 OK` when no active enrollment found
- `POST /sequences/unenroll` route
- `src/consumers/opt-out.consumer.ts` — SQS consumer for `opt_out.received`:
  - Extract `entity_id`, find all active enrollments across all sequences
  - Run unenrollment for each
  - Publish `nurturing.all_sequences_cancelled`
  - Validate + handle malformed events without crashing
- Unit tests: `unenrollment` (cancels all pending steps, leaves non-pending untouched, idempotent on missing enrollment)
- Integration tests: unenroll mid-sequence → pending steps `cancelled`, in-flight step worker exits cleanly via optimistic lock; `opt_out.received` → all active enrollments for entity cancelled across sequences

---

## Phase 7 — Resilience (Startup Scanner + Safety-Net Poller)

**Deliverables:**
- `src/services/startup-scanner.ts`:
  - On service start: async background scan for `job_id IS NULL AND status = 'pending'`
  - Re-enqueues each and writes back `job_id`
  - Non-blocking — server accepts HTTP traffic immediately
- `src/services/safety-net-poller.ts` — Fastify plugin:
  - `setInterval` every 5 minutes
  - Query: `status = 'pending' AND scheduled_at < now() - 1 minute AND job_id IS NOT NULL`
  - Redis distributed lock (SET NX EX) — only one ECS instance runs the poll cycle
  - Re-enqueues orphaned jobs
- Integration tests: startup scanner re-enqueues `job_id = NULL` step, server accepts traffic before scan completes; safety-net poller re-enqueues overdue step with non-null `job_id`, executes correctly, no duplicate send (Messaging Service `dedup_key` guard)

---

## Phase 8 — Stats API + Contract Tests

**Deliverables:**
- `src/routes/stats.ts` — `GET /sequences/:id/stats`:
  - Counts: total, completed, unenrolled, failed, active enrollments
  - Rates: `completion_rate`, `unenrollment_rate`
  - A/B block: per-variant enrollment count, completion rate, `conversion_count`, `conversion_rate`
  - Two-proportion z-test: `significant = true` when p < 0.05 AND both variants ≥ 100 enrollments; `winner` set to higher-conversion variant when significant, `null` otherwise
  - `ab` key is `null` when no A/B test configured on sequence
- Unit tests: z-test computation (correct p-value, significance threshold, winner logic, null when not significant)
- **Contract tests** (outbound — verify calls to platform services match expected shape):
  - `POST /templates/render` — `template_id` + context, called before send actions
  - `POST /messages/send` — pre-rendered `body` (not `template_id`), `dedup_key` present
  - `POST /emails/send` — pre-rendered `subject` + `body_html` + `body_text`, required fields present
  - `POST /ai/complete` — `{ system_prompt, user_prompt, model }` only
  - EventBridge `nurturing.*` event payload shapes against `@ortho/event-bus` schema
- **Contract tests** (inbound):
  - `opt_out.received` SQS consumer correctly handles malformed events without crashing
