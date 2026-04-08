# Clarifying Questions: Campaign Service

> Original request: Implement the Campaign Service as defined in `docs/superpowers/specs/2026-03-25-campaign-service-design.md` — email broadcast campaign lifecycle with comment-based approval workflow, BullMQ send orchestration, A/B holdout/full-split testing, and 7-day conversion attribution.

## Questions

1. **Inbound event consumption pattern**. The spec references a dedicated `sqs-consumer.ts` in the service layout. The `@ortho/event-bus` ADR uses `bus.subscribe(eventType, handler)` + `bus.start()`, which internally polls the dedicated SQS queue (`SQS_QUEUE_URL`). Which pattern should the Campaign Service use for receiving `email.campaign_completed`, `email.opened`, and `lead.stage_changed`?
   A. `@ortho/event-bus` — `bus.subscribe(eventType, handler)` × 3 + `bus.start()`, consistent with all other services; `sqs-consumer.ts` is just the startup wiring
   B. Raw SQS SDK polling in a custom `sqs-consumer.ts` — more control over batching and visibility timeout, independent of the event-bus abstraction
   C. Other: [please specify]

   **Answer:** A

2. **Outbound event publishing**. For publishing `campaign.sent` to EventBridge, should `src/events/publisher.ts` use `@ortho/event-bus` `bus.publish()` (same bus instance as subscriptions) or call the AWS EventBridge SDK directly?
   A. `@ortho/event-bus` `bus.publish()` — single bus instance handles both inbound subscriptions and outbound publish, consistent with all other services
   B. AWS EventBridge SDK directly — publisher is decoupled from the consumer bus instance
   C. Other: [please specify]

   **Answer:** A

3. **`@ortho/types` updates scope**. The campaign service requires event types not yet in `@ortho/types`:
   - `CampaignSentPayload` / `CampaignSentEvent` (outbound, for `campaign.sent`)
   - `EmailCampaignCompletedPayload` (inbound, from Email Service)
   - `EmailOpenedPayload` with `campaign_job_id` + `entity_id` (inbound, after Email Service spec amendment)
   - `occurred_at: string` added to existing `LeadStageChangedPayload` (currently missing; required for 7-day attribution anchor)

   Should these additions be in scope for this PRD?
   A. Yes — include `@ortho/types` updates as tasks within this PRD
   B. No — define inline types locally in the campaign service; update `@ortho/types` in a separate pass
   C. Partial — add only `occurred_at` to `LeadStageChangedPayload` (shared type fix); define campaign-specific event types locally
   D. Other: [please specify]

   **Answer:** A

4. **Manager-only route authorization**
   The permission matrix (spec §3.3) requires Marketing Manager for approve, reject, schedule, unschedule, send-now, and cancel. `@ortho/auth-middleware` offers `requirePermission(perm)` (role→permission map) and `requireRole(roles[])` (exact role check). Both `marketing_staff` and `marketing_manager` have `campaigns:write` — so `requirePermission` alone doesn't distinguish them. What guard strategy should manager-only routes use?
   A. `requireRole(['marketing_manager', 'super_admin'])` — all campaign routes use `requirePermission('campaigns:write')`; manager-only actions stack a `requireRole` guard on top
   B. Add a new `campaigns:manage` permission to `ROLE_PERMISSIONS` in `@ortho/auth-middleware`, grant only to `marketing_manager` and `super_admin`; use `requirePermission('campaigns:manage')` on those routes
   C. Other: [please specify]

   **Answer:** A + B

5. **Database access pattern**
   CLAUDE.md lists `@ortho/db` (Knex + migration runner) as a shared package, but it doesn't exist in `packages/` yet. How should the Campaign Service access PostgreSQL?
   A. Raw Knex directly — `import Knex from 'knex'`; configure from `DATABASE_URL`; `knex migrate:latest` in the service
   B. Block and build `@ortho/db` first as a prerequisite before the Campaign Service
   C. Other: [please specify]

   **Answer:** A

6. **Migration execution**
   When and how should `crm_campaigns` schema migrations run?
   A. Auto-migrate at service startup — `knex.migrate.latest()` before Fastify starts accepting connections
   B. Separate Dockerfile step — `CMD ["node", "dist/migrate.js"]` runs before the main service command in ECS
   C. CI/CD pre-deploy step — migrations run in the pipeline; service startup does not auto-migrate
   D. Other: Same Dockerfile, separate docker-compose service (migrator)

   **Answer:** 

7. **Redis connection for BullMQ**
   BullMQ needs a Redis connection for `campaign-orchestrate` and `ab-winner-select` queues. Should BullMQ use the same Redis instance as the event-bus (`REDIS_URL`), or a separate connection?
   A. Same Redis instance — BullMQ uses `REDIS_URL`; queue names are prefixed (e.g. `campaign:`) to avoid stream key collision
   B. Separate `BULLMQ_REDIS_URL` env var — different Redis instance or logical database to isolate queue storage from event streams
   C. Other: [please specify]

   **Answer:** B

8. **Campaign list default visibility**
   `GET /campaigns` supports `?created_by=uuid` as a filter. What is the default (no `created_by` filter) for Marketing Staff?
   A. All campaigns visible by default — `created_by` is a voluntary filter; no ownership restriction
   B. Marketing Staff see only their own campaigns by default; Marketing Manager sees all
   C. Other: [please specify]

   **Answer:** A

9. **Process structure**
   The service has three concurrent concerns: Fastify REST API, BullMQ workers (`campaign-orchestrate`, `ab-winner-select`), and the SQS event consumer. How should these be deployed?
   A. Single process — Fastify + BullMQ workers + SQS consumer all start in one `node dist/index.js`; simplest ECS task definition
   B. Separate processes — Fastify in one ECS task, BullMQ workers + SQS consumer in another; independent scaling
   C. Other: As B, but have separate start scripts in package.json

   **Answer:**  C

10. **Test fixture strategy**
    CLAUDE.md mentions `@ortho/testing` (fixtures, mocks, factories), but the package doesn't exist in `packages/` yet. How should integration tests manage test data (campaign records, lead stubs, send rows)?
    A. Inline factory functions per test file — no shared package dependency
    B. Shared factories in `test/helpers/` within the campaign service — reused across test files within the service
    C. Build `@ortho/testing` as a prerequisite before campaign service integration tests
    D. Other: [please specify]

    **Answer:** B

11. **Contract test mechanism**
    The spec defines 9 contract assertions (outbound payload shapes + inbound event shapes). How should these be implemented?
    A. TypeBox schema validation — define `TSchema` for each payload; use `Value.Check()` in Vitest tests; catches shape errors at runtime
    B. Plain Vitest `expect(payload).toMatchObject({...})` assertions — no schema library needed; fast to write
    C. Other: [please specify]

    **Answer:** A

12. **Audience pre-filter extraction**
    Spec §6.1 step 5 says to pre-filter `GET /leads` using dimensions extractable from the segment filter (e.g. `location_id`, `pipeline`, `stage`). The note says this is optional for correctness. How should `audience-resolver.ts` handle this for v1?
    A. Ad-hoc inspection — scan `audience_filter` JSONB for top-level `{ field, op, value }` conditions matching known Lead Service query params; apply as pre-filters
    B. Skip pre-filtering entirely for v1 — fetch all active leads from Lead Service without pre-filtering; Audience Engine applies the full filter
    C. Other: [please specify]

    **Answer:**  A

13. **Implementation phasing**
    The spec covers a large surface: CRUD + approval workflow, BullMQ orchestration, non-A/B send, A/B holdout + full-split, conversion attribution, diagnostics (spam-check, test-send, sends/conversions/events endpoints), crash recovery, and a full test suite. Should this be built in one phase or split?
    A. Single phase — full spec end-to-end; Ralph implements all stories in one run
    B. Two phases — Phase 1: CRUD + approval workflow + non-A/B orchestration + conversion attribution; Phase 2: A/B testing (holdout + full_split) + diagnostics + crash recovery hardening
    C. Three phases — Phase 1: CRUD + approval; Phase 2: orchestration + non-A/B send; Phase 3: A/B + attribution + diagnostics
    D. Other: [please specify]

    **Answer:** C

