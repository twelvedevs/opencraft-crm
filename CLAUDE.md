# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

This is a **pre-sale planning repository** for **Ortho CRM** — an orthodontic-specific CRM platform. No implementation exists yet.

## Key Documents

- `docs/00-prd-1.md` — Full PRD (v1.0, March 2026). Authoritative source for product decisions.
- `docs/01-platform-arch-design.md` — Platform architecture design (Draft, March 2026). Authoritative source for technical decisions.
- `docs/superpowers/specs/` — Component-level design specs (naming: `YYYY-MM-DD-{component}-design.md`). Authoritative for their named component once status is **Approved**.
  - `2026-03-24-automation-engine-design.md` — **Approved**
  - `2026-03-25-nurturing-engine-design.md` — Draft
  - `2026-03-25-messaging-service-design.md` — Draft
  - `2026-03-25-notification-service-design.md` — Draft
  - `2026-03-25-template-service-design.md` — Draft
  - `2026-03-25-audience-engine-design.md` — Draft
  - `2026-03-25-ai-service-design.md` — Draft
  - `2026-03-25-analytics-service-design.md` — Draft
  - `2026-03-25-integration-hub-design.md` — Draft
  - `2026-03-25-media-service-design.md` — Draft
  - `2026-03-25-identity-service-design.md` — Draft
  - `2026-03-25-lead-service-design.md` — Draft
  - `2026-03-25-pipeline-engine-design.md` — Draft
  - `2026-03-25-conversation-service-design.md` — Draft
  - `2026-03-25-reporting-service-design.md` — Draft
  - `2026-03-25-referral-service-design.md` — Draft

## Architecture

Two-layer SOA with 21 independently deployable services in a Turborepo monorepo:

**Platform Layer (12 services)** — domain-agnostic, reusable across future products:
Messaging (Twilio), Email (SendGrid), Notification (SSE + Redis pub/sub), Template, Nurturing Engine (drip sequences), Automation Engine (event-driven workflows), Audience Engine (segment evaluation), AI (Claude API gateway), Analytics, Integration Hub (Google Ads + Meta), Identity (auth/RBAC), Media (S3/CloudFront)

**Product Layer — Ortho CRM (8 services)** — consume platform via REST + events:
Lead Service (core entity), Pipeline Engine (state machine), Conversation Service (SMS inbox), Campaign Service (email broadcasts), Referral Service, Reporting Service, Data Import Service (Ortho2 CSV), CRM API Gateway

**Frontend (1 app):** React 18 + TypeScript SPA at `apps/crm/web`. Embeds platform UI components (`@platform/template-ui`, `@platform/sequence-ui`, `@platform/audience-ui`, `@platform/automation-ui`) as React packages.

### Monorepo Structure

```
ortho/
├── apps/
│   ├── platform/        # 12 platform services (messaging, email, notification, etc.)
│   └── crm/
│       ├── lead/
│       ├── pipeline/
│       ├── conversation/
│       ├── campaign/
│       ├── referral/
│       ├── reporting/
│       ├── import/
│       ├── api-gateway/
│       └── web/         # React SPA
├── packages/
│   ├── @ortho/types         # shared TS interfaces for events + API contracts
│   ├── @ortho/event-bus     # typed EventBridge client
│   ├── @ortho/auth-middleware
│   ├── @ortho/db            # Knex/Drizzle, migration runner
│   ├── @ortho/logger        # Pino, Datadog-compatible
│   ├── @ortho/testing       # fixtures, mocks, factories
│   ├── @platform/filter-engine  # shared pure-function filter evaluator (Automation + Audience engines)
│   └── @platform/*-ui       # React component packages
└── infra/               # IaC (AWS CDK or Terraform)
```

Each service follows: `src/{routes,services,repositories,events}/` + `migrations/` + `test/` + `Dockerfile`

### Communication Patterns

**Async — AWS EventBridge** for state-change propagation (no direct coupling between publisher and consumer).

**Sync — REST** for queries and immediate commands (e.g. `POST /templates/render`, `POST /messages/send`, `POST /ai/complete`).

### Notification Service — Key API Decisions

Transport: SSE (not WebSocket) — strictly server-to-client. Product services call `POST /notifications/publish` directly (no EventBridge). Redis pub/sub (`PSUBSCRIBE notif:*`) handles cross-instance fan-out. Channels are arbitrary strings; channel access control enforced via JWT claims (`location:{id}:*` checks location claims, `user:{id}:*` checks JWT subject). Persistence: 7-day TTL, one row per publish, per-user read state in `notification_reads`. `Last-Event-ID` replay uses monotonic `seq bigint` (Postgres sequence), not UUID. `read-all` publishes single bulk Redis message → `event: read-all` SSE type. `POST /notifications/:id/read` returns `404` for expired/missing notifications.

### Template Service — Key API Decisions

`POST /templates/render` accepts `template_id` (uuid) + `context` object → returns rendered `body_text` (SMS) or `subject` + `body_html` + `body_text` (email). Always renders `active_version` — returns `404` if `active_version IS NULL` or `status = disabled`. Merge tag syntax: `{{key}}` with dot-notation support. Missing tags → empty string + log. In-memory cache 30s TTL; `POST /templates/:id/disable` eagerly evicts cache. Email templates store pre-rendered HTML (Unlayer export) + Unlayer JSON (for re-editing); SMS templates store plain text. Two-table versioning: `templates` group + `template_versions`. **Call chain:** Automation Engine and Nurturing Engine workers call `POST /templates/render` first, then pass pre-rendered body to Messaging/Email Service — Messaging Service never calls Template Service. **Pending:** Automation Engine spec (Section 6) and Nurturing Engine spec need amendments to reflect this call chain.

### Audience Engine — Key API Decisions

Callers submit entity data (hybrid push model) — engine never calls product APIs. Named segments (versioned, draft/active/disabled) + inline one-offs. `POST /audiences/segments/:id/evaluate` (batch, caller-generated `snapshot_id`) → entity-ID-only snapshot, 48h TTL. `POST /audiences/evaluate` (inline, `snapshot: false` returns IDs directly; `snapshot: true` stores snapshot). `POST /audiences/segments/:id/check` (single entity, synchronous, no snapshot). Snapshot cleanup: per-snapshot BullMQ delayed job + hourly safety-net sweep. Membership check cache: full resolved segment keyed by `segment_id`, 30s TTL. Shared `@platform/filter-engine` package (pure functions, zero deps) used by both Automation Engine and Audience Engine — Automation Engine migration replaces `condition-evaluator.ts` with thin wrapper passing event object as entity. Extended temporal operators: `within_last`, `not_within_last`, `before`, `after`, `date_range` (Audience Engine only). `@platform/audience-ui`: `<SegmentBuilder fields onSelect onFetchEntities? />` + `<AudiencePreview segmentId />`.

### AI Service — Key API Decisions

Thin Claude API gateway — no stateful agent behavior (AI Agent autonomous mode lives in Conversation Service). Single endpoint: `POST /ai/complete` with `{ prompt_id, context, model? }` → `{ text, model, prompt_id, cached }`. Sync only (no streaming). Static prompts as TypeScript files in `src/prompts/` — changes require deploy. Model routing: `"haiku"` → `claude-haiku-4-5-20251001`, `"sonnet"` → `claude-sonnet-4-6`; prompt sets default, caller can override; invalid model string → 400. Response cache: L1 in-memory LRU 500 entries / 60s TTL + L2 Postgres `ai_completions` 5min TTL, keyed on SHA256(prompt_id + model + canonicalized context). `ai_completions` is a response cache only — not an audit log. LLM observability via Arize Phoenix (OpenInference SDK instrumentation; `ARIZE_PHOENIX_ENDPOINT` env var). No Redis, no BullMQ, no events published. Error shape: `{ "error": "<message>" }` — 503 for all Claude API errors (5xx, 429, 529). **Pending:** Arch doc Section 2.1 lists "streaming" and "usage metering" for AI Service — both are out of scope; arch doc needs amendment.

### Analytics Service — Key API Decisions

EventBridge → SQS → typed event handlers → atomic write: raw `analytics_events` log + daily rollup table update (single DB transaction). Nine typed handlers dispatched via plain `switch` in `event-router.ts` (no registration map). Storage: `analytics_events` (24-month partitioned, with default partition for late-job safety) + 6 named rollup tables (`metrics_leads_daily`, `metrics_pipeline_daily`, `metrics_conversions_daily`, `metrics_messages_daily`, `metrics_ad_spend_daily`, `metrics_campaigns_daily`). Idempotency: `ON CONFLICT (event_id) DO NOTHING` on raw insert skips rollup for counter-increment handlers — **exception:** `AdSpendSyncedHandler` always executes rollup upsert to allow corrected re-syncs. Ad spend arrives via `ad_spend.synced` event from Integration Hub (payload: `platform`, `location_id`, `synced_date` + `records[]`). API: named endpoint families `GET /analytics/metrics/{leads|pipeline|conversions|messages|ad-spend|campaigns}` with shared `period`/`granularity`/`location_id` params + `POST /analytics/query` generic DSL against raw event log (single event type, equality/IN filters, 10k row cap). No platform UI component — Reporting Service owns dashboard. **Pending amendments required:** Messaging Service spec (add `location_id` to `message.delivered`, `message.failed`, `opt_out.received` payloads); Campaign Service spec (`campaign.sent` must carry `campaign_id`, `location_id`); Email Service spec (add `email.opened`, `email.clicked` events with `campaign_id`, `location_id`); arch doc event table (add all above events); Analytics spec (add `lead.archived` subscriber). Pipeline Engine payload shapes resolved — `lead.stage_changed` carries `location_id`/`pipeline`/`stage_to`; `lead.converted` carries `location_id`/`channel`.

### Integration Hub — Key API Decisions

Pluggable `Connector` interface (`platform`, `getAuthorizationUrl`, `exchangeCode`, `refreshTokens`, `fetchSpend`, `fetchSpendRange`, `verifyWebhook`, `parseLeadWebhook`). `ConnectorRegistry` maps platform string → implementation. Initial adapters: `google_ads`, `facebook_ads`. DB tables: `integration_accounts` (one row per connected ad account, tokens AES-256-GCM encrypted via AWS Secrets Manager key) + `campaign_location_mappings` (one-to-one: each campaign maps to exactly one `location_id`; opaque string to this service). **Unmapped campaigns are not published** — spend is dropped until mapping is configured; re-mapping does not retroactively re-attribute historical spend. BullMQ jobs: `poll-ad-spend` (repeatable per account, every 4 hours — groups records by `location_id`, publishes one `ad_spend.synced` event per `(platform, location_id, date)`); `refresh-token` (delayed one-off per Google Ads account, re-queued 30min before expiry — not used for Meta); `process-lead-webhook` (one-off per lead, job ID `{platform}:{external_lead_id}` for dedup); `backfill-ad-spend` (one-off, 7-day chunks, same publish pattern as poll). `ad_spend.synced` payload: `{ platform, location_id, synced_date, records: [{ campaign_id, campaign_name, spend, impressions, clicks }] }` — top-level `location_id`, no `location_id` inside records. `ad_lead.received` payload: `{ platform, external_lead_id, campaign_id, ad_set_id?, ad_id?, form_id?, location_id, fields: { full_name, phone_number, email } }`. Webhook route handler: verify signature → call `parseLeadWebhook()` synchronously (pure, no I/O) → enqueue one job per `LeadEvent`; malformed payload → log warn + return 200. Meta token expiry = manual reconnect only (no auto-refresh). Google Ads token refresh = `refresh-token` delayed job; on failure sets `status = 'error'`, manual reconnect required. `@platform/integration-hub-ui`: `<ConnectedAccounts />`, `<OAuthConnectButton platform onSuccess />`, `<CampaignLocationMapper accountId locations onSave />`, `<BackfillTrigger accountId onComplete />`. Backfill status via `GET /integrations/accounts/:id/backfill/:job_id`.

### Media Service — Key API Decisions

Two-tier S3 storage: public bucket (`ortho-media-public`) via CloudFront permanent URLs (logos, email images) + private bucket (`ortho-media-private`) via 15-min presigned S3 GET URLs (consent photos, PDFs). Upload flow: presigned PUT + confirm (primary) or proxy multipart POST (secondary) — both converge on same processing logic. S3 key pre-computed at `POST /media/upload-url` time (deterministic from `upload_id` + `filename`). Image processing: `sharp`, synchronous on confirm/upload — resize to `medium` (800px WebP, q85) + `thumb` (200px WebP, q80); original tracked in `media_files.original_key`, derived variants in `media_variants`. 20MB limit enforced via `file_size_bytes` body field + S3 `content-length-range` backstop. Access control: JWT `location_id` claim vs `media_files.location_id` — no Identity Service call per request. Confirm authorization: JWT `sub` must match `uploaded_by` (403 if not). Public file deletion blocked at user-facing API (403). Internal endpoints (`POST /media/internal/store`, `GET /media/internal/:file_id/signed-url`): shared service auth token, no `location_id` check; `uploaded_by` set to `SERVICE_CALLER_ID` sentinel UUID. Separate TTL env vars: `PRESIGNED_PUT_TTL_SECONDS` + `PRESIGNED_GET_TTL_SECONDS` (both default 900s). Orphan cleanup: transactional hourly `node-cron` — deletes pending files scoped to expired intents subquery, then deletes intents. No EventBridge events published. CSV imports and call recordings are explicitly out of scope. Template Service browser uploads go directly from browser to Media Service — Template Service backend never calls Media Service.

### Identity Service — Key API Decisions

Auth provider (Supabase Auth or Auth0) is a pluggable credential vault — selected via `AUTH_PROVIDER=supabase|auth0` env var using a `AuthProvider` interface (`verifyToken`, `createUser`, `setPassword`, `deactivateUser`). Identity Service owns the `users` table (not the auth provider). **Login flow (Approach C):** frontend authenticates directly with the auth provider → gets provider token → `POST /identity/session` → Identity Service validates token, loads role + location assignments, issues enriched JWT (RS256, 15min TTL) + refresh token (30-day TTL). **JWT claims:** `{ sub, role, locations[], must_change_password, iat, exp }`. Role enum: `call_center_agent | call_center_manager | marketing_staff | marketing_manager | super_admin`. `locations[]` semantics: agents = one location, managers = one or more, marketing/super_admin = `[]` (interpreted as all locations). **RBAC enforcement:** JWT-claims-based only — no per-request Identity Service call. `@ortho/auth-middleware` resolves permissions from static `ROLE_PERMISSIONS` map via `require-permission.ts` (fine-grained) or `require-role.ts` (admin-only gates) + `require-location.ts`. `must_change_password: true` → middleware returns `403 password_change_required` on all routes except `PUT /identity/me/password`, `GET /identity/me`, `DELETE /identity/session`. **Key rotation:** dual-key JWKS (`IDENTITY_JWKS_KEYS`), `kid` in JWT header; 15-min overlap window; unknown `kid` triggers JWKS re-fetch with back-off. **Refresh tokens:** rotation on use; replay (revoked token reused) → full session invalidation (bulk revoke all tokens for user). **Deactivation:** bulk-revokes refresh tokens + `AuthProvider.deactivateUser()`; 15-min JWT bleed accepted. Re-activation out of scope for launch. **API keys:** `ak_<32 hex>` prefix, SHA256 hash stored, permissions scoped, no expiry, revoke-only; `POST /identity/api-keys/validate` is VPC-only protected by `INTERNAL_API_SECRET` header (not a service JWT). BullMQ daily cleanup: prune expired + old revoked refresh tokens. No EventBridge events published. Bootstrap: `seed-super-admin.ts` reads `SEED_EMAIL`+`SEED_PASSWORD` env vars, `force_password_reset = true`.

### Pipeline Engine — Key API Decisions

Hardcoded TypeScript state machine (`state-machine.ts`) — 3 pipelines (`new_patient` / `in_treatment` / `in_retention`), 13 stages; no DB-configurable stages. REST-only inbound via CRM API Gateway — no EventBridge subscriptions; all transitions (coordinator, Data Import Service, Automation Engine-triggered) route through the gateway. Pipeline Engine is source of truth in `crm_pipeline` schema; Lead Service caches `current_pipeline`/`current_stage` via `lead.stage_changed` subscription. Two DB tables: `pipeline_memberships` (mutable current state, `UNIQUE (lead_id, pipeline) WHERE status = 'active'`) + `pipeline_stage_history` (immutable log, `stage_to NOT NULL`). Timeout enforcement: `node-cron` every 15min with `SELECT ... FOR UPDATE SKIP LOCKED` for multi-instance safety — no Redis/BullMQ. Stage timeout auto-transitions + publishes `lead.stage_changed` (reason: `timeout`) + `lead.stage_timeout`. `lost` 30-day expiry → `status = archived` → publishes dedicated `lead.archived` event (not `lead.stage_changed`; no history row inserted for archival). `/convert` endpoint is atomic (`SELECT FOR UPDATE`): closes source membership + opens target + publishes **both** `lead.converted` AND `lead.stage_changed` (stage_from: null, reason: `converted`) for the new enrollment. `override: true` bypasses transition graph; requires non-null `triggered_by`; allowed for `call_center_manager+` only (enforced at API Gateway). `recall_due` timeout is variable — caller passes `timeout_at` (absolute datetime); `400` if absent on transition or enrollment. `new_lead` 2h window = UI warning only, no auto-transition. Valid `channel` enum on `lead.converted`: `google_ads|facebook|website|referral_patient|referral_doctor|call_tracking|walk_in|chat|google_business|import|unknown` — CRM API Gateway resolves from Lead Service before calling `/convert`. **Pending:** Analytics spec needs `lead.archived` subscriber added.

### Lead Service — Key API Decisions

Core entity store (`apps/crm/lead`, schema `crm_leads`). Pipeline Engine is authoritative for stage state; Lead Service caches `current_pipeline`/`current_stage` (denormalized) updated via `lead.stage_changed` event subscription. Activity timeline is a materialized projection written by a BullMQ SQS worker — atomic DB transaction per event (state update + timeline insert). Rule-based priority score in pure `score-calculator.ts` — recalculated synchronously in worker; stage time limits hardcoded as constants matching PRD values. `contact_status` enum: `active | sms_opted_out | email_invalid | fully_unreachable` — updated via `opt_out.received`, `opt_out.removed`, `email.bounced` events. Tag registry: `tags` table (per-location + global null) + `lead_tags` join. Search: `pg_trgm` GIN indexes on name/phone/email, `GET /leads?q=` with 0.2 similarity threshold. Attribution fields immutable after creation — `PATCH /leads/:id` rejects them with `400`. `location_id` reassignment restricted to manager+ role; appointments keep their original `location_id`. `ad_platform_lead_id` is an idempotency key for `ad_lead.received` handler (skip creation if exists). Archived and merged-away leads remain queryable via `GET /leads/:id` (soft delete only). `source_event_id` idempotency: EventBridge event ID for SQS-sourced activities; semantic stable keys for internal (e.g. `"internal:lead.created:{lead_id}"`). Messaging Service events carry phone numbers, not `lead_id` — handlers resolve lead via phone lookup (`phone_number` for opt-out events, `to_number` for delivered/failed, `from_number` for inbound). Audience Engine: Campaign Service orchestrates evaluation using `GET /leads` as data source — Lead Service never calls Audience Engine. Score commentary on-demand via `GET /leads/:id/score-commentary` → calls AI Service. **Pending amendments:** Messaging Service spec must add Lead Service as subscriber to `message.delivered`, `message.failed`, `inbound_message.received`; Email Service spec must define `email.bounced` with `{ to_address, bounce_type: "hard|soft" }`; Lead Service must subscribe to `lead.archived` to clear `current_pipeline`/`current_stage` cache. Pipeline Engine spec now written — `reason` field on `lead.stage_changed` defined; archival uses `lead.archived` event (no `stage_to: null` on `lead.stage_changed`).

### Conversation Service — Key API Decisions

Product-layer SMS inbox (`apps/crm/conversation`, schema `crm_conversations`). Bridges Messaging Service ↔ Lead records. Conversation Service owns its own message store (Approach A) — all inbox reads are self-contained. **Conversation model:** one lead can have multiple conversation threads; keyed by `(lead_id, practice_number)` where `practice_number` is the Twilio number on the practice side; new conversation created when most recent thread for that pair has been inactive for longer than `location_conversation_settings.inactivity_days` (default 30, configurable per location). `status: 'closed'` is a UI-layer signal only — inbound reply within the inactivity window auto-reopens and appends; expired window creates a new conversation. **Inbound routing:** sync call to Lead Service `GET /leads?phone={from_number}` on every inbound message; no local phone cache. `STOP`/`UNSTOP` (`message_type != 'normal'`) stored in thread but skip AI agent processing. **AI Agent mode:** location-level `agent_mode_enabled` + per-conversation `agent_mode_active`; BullMQ job per inbound reply; escalation via structured JSON `{ text, escalate }` parsed from `conversation-agent-reply` prompt (no confidence field — parse failure = escalation); `agent_exchange_count` resets to `0` when `agent_mode_active` is re-enabled; `dedup_key` for agent sends = `'agent:' + conversation_id + ':' + agent_exchange_count`. **Human takeover:** manual send OR coordinator assignment sets `agent_mode_active = false`; only `marketing_manager` can re-enable. **Bulk SMS:** Lead Service paginate → build `Map<id, lead>` → Audience Engine `POST /audiences/evaluate` (push model) → send via Messaging Service; `from_number` = `location_conversation_settings.practice_number` (not from any conversation). **Scheduled send:** BullMQ delayed job; cancel = DB update + `job.remove()`. **`location_conversation_settings`** stores: `inactivity_days`, `agent_mode_enabled`, `agent_max_exchanges`, `location_phone` (voice, disclosure footer), `practice_number` (Twilio, bulk SMS); CHECK constraint prevents enabling agent mode without both phone fields set. **Published event:** `message.received` with `entity_type: "lead"`, `entity_id` (= lead_id). **Notification Service** called directly via `POST /notifications/publish`. **AI Service prompts needed** (must be added to AI Service registry): `conversation-reply-drafts`, `conversation-summary`, `conversation-objection-handling`, `conversation-agent-reply`. **Pending amendment:** Lead Service spec must add `GET /leads?location_id=&status=active` with cursor pagination (required by bulk SMS worker).

### Referral Service — Key API Decisions

Two referral programs: **patient** (auto-created on `lead.converted` to `in_retention`) and **doctor** (staff-created with contact info). Schema `crm_referrals`. **Attribution flow (client-side):** embeddable form widget calls public `GET /referrals/links/:code` → gets `{ referrer_id, referral_link_id, referrer_type, referrer_name }` → embeds `referrer_id`, `referral_link_id`, `referrer_type`, `referral_code` as hidden form fields → Lead Service stores all four as immutable attribution → publishes in `lead.created` payload. **`lead-created.ts` handler:** resolves specific link via `referral_code` (active or inactive); code-not-found → log warn + skip (no fallback to active link — mis-attribution is worse than no attribution). Handler blocked until Lead Service amendment adds these fields. **Patient referrer creation (Branch B):** on `lead.converted` to `in_retention` → call `GET /leads/:id` (internal API key) → create `referrers` row + `referral_links` row → publish `referrer.created` post-commit. **Race condition fix:** Automation Engine subscribes to `referrer.created` (not `lead.converted`) to enroll patient in post-treatment sequence — guarantees referral link exists before sequence context is built. **`referral_link_url` in `referrer.created`:** must be `REFERRAL_BASE_URL + /referrals/r/ + code` (redirect endpoint URL for click tracking) — NOT the landing page URL with `?ref=` baked in. **Inactive redirect codes:** `GET /referrals/r/:code` returns `302` to `redirect_url` without `?ref=` (not `404`) — prospective patient still reaches practice website. **SMS notifications:** Referral Service calls Messaging Service directly with `dedup_key = "referral_exam_notify:{referral_id}"` (on `exam_scheduled`) and `"referral_conversion_notify:{referral_id}"` (on conversion) — patient referrers only; doctor thank-you deferred for launch. **Reward tracking:** `reward_events` auto-created `pending` on `lead.converted` to `in_treatment`; staff marks `issued` with `reward_type` required. **Doctor portal:** long-lived token URL `GET /referrals/portal/:token` — no auth; `portal_tokens` table with `UNIQUE (referrer_id)`; `400` if patient referrer (service-layer guard). **Published events:** `referral.converted` (→ Lead Service timeline, Analytics) + `referrer.created` (→ Automation Engine). **Subscribed events:** `lead.created` (create tracking record), `lead.stage_changed` (exam_scheduled + pipeline = new_patient guard), `lead.converted` (both branches). **Pending amendments:** Lead Service spec (add `referrer_id`, `referrer_type`, `referral_code` to `leads` table DDL + `lead.created` payload); arch doc (add `referral.converted` + `referrer.created` to event table); Analytics spec (add `referral.converted` handler + `metrics_referrals_daily`); Automation Engine spec (add `referrer.created` to trigger catalog, `entity_type = 'referrer'`, document payload fields as context variables for `enroll_sequence` action); Pipeline Engine spec (confirm `to_pipeline` field on `lead.converted` payload).

### Reporting Service — Key API Decisions

Product-layer query-and-delivery service (`apps/crm/reporting`, schema `crm_reporting`). Computes Ortho-specific KPIs from Analytics Service data — owns **no metrics tables** (thin query-time computation layer). **Architecture:** Fans out parallel Analytics Service calls per dashboard request, computes derived KPIs (cost per case, ROAS, funnel rates, coordinator metrics), returns results. 5-min in-process LRU cache (500 entries) keyed on `sha256(metric_family + period + sorted(location_ids))` — per-instance, no shared state. **Schema** — 4 tables only: `location_revenue_config` (per-location `avg_contract_value`, opaque location_id string), `report_configs` (parameterized saved report definitions), `report_schedules`, `report_runs` (immutable log). **Report types:** `weekly_summary | monthly_executive | channel_deep_dive | coordinator_productivity | lead_source` — each configurable with period/location/channel filters. **PDF delivery:** Puppeteer (per-job browser, 30s timeout, finally-close) → Media Service private bucket → `/runs/:id/download` (302 to fresh presigned URL) link in email body — NOT a pre-baked presigned URL (15-min TTL would expire before most reads). **Delivery via Email Service** (not SendGrid direct); all recipients must be CRM users (v1). **Scheduled reports:** BullMQ repeatable jobs (`jobId = report-schedule:{id}`); startup reconciliation re-registers missing jobs after Redis flush. **Service-to-service auth:** `ANALYTICS_API_KEY` env var (Identity Service API key, `ak_`-prefixed) for all Analytics Service calls — applies to both sync (dashboard) and async (scheduled jobs). **No EventBridge subscriptions** — pure query consumer. **Coordinator metrics:** use existing `triggered_by` field on `lead.stage_changed` as coordinator dimension — no new `coordinator_id` field; Analytics Service gets `metrics_coordinators_daily` rollup with `response_time_count` + `time_in_stage_count` columns for correct incremental mean. **`locations[] = []` (marketing roles):** omit `location_id` param entirely when calling Analytics Service — never pass empty array. **network_average** in location-comparison: only returned for `marketing_staff+`; `null` for location-scoped roles. **`/retry` + `/download` auth:** caller must be `triggered_by` user OR have location access to all config location_ids; `marketing_manager+` passes unconditionally. **Pending amendments:** Pipeline Engine spec (add `response_time_seconds` when `stage_to = 'contacted'` + `time_in_stage_seconds` to `lead.stage_changed`; confirm `triggered_by` on `lead.converted`); Analytics Service spec (add `metrics_coordinators_daily` rollup + `GET /analytics/metrics/coordinators` + pre-middleware Fastify plugin for `ak_`-prefixed API key auth — do NOT modify `@ortho/auth-middleware`); arch doc (remove Reporting Service from `lead.converted` subscribers; add REST call table entry).

### Messaging Service — Key API Decisions

`POST /messages/send` accepts `template` (string) + `context`, or pre-rendered `body`. Callers embed the template string inline — the Messaging Service does not store templates by ID. Duplicate `dedup_key` returns `200` with the original `message_id` (not `409`). Events published: `inbound_message.received` (includes `message_type`: `normal`|`stop`|`unstop`), `message.delivered`, `message.failed`, `opt_out.received`, `opt_out.removed`. Event payloads: `opt_out.received` = `{ phone_number, opted_out_at, source }`, `opt_out.removed` = `{ phone_number, removed_at }`, `message.delivered`/`message.failed` = `{ message_id, twilio_sid, to_number, from_number, ... }`, `inbound_message.received` = `{ message_id, from_number, to_number, body, media_urls, received_at, message_type }`. No `lead_id` in any Messaging Service event — domain-agnostic.

### Campaign Service — Key API Decisions

Product-layer email broadcast campaign lifecycle service (`apps/crm/campaign`, schema `crm_campaigns`). **Status machine:** `draft → pending_review → approved → scheduled → sending → completed/completed_with_errors/failed/cancelled`; `scheduled → approved` via unschedule (sets `orchestrate_job_id = NULL`); cancellation allowed from any pre-sending state (including `pending_review`); blocked once `sending`. **Approval:** comment-based review via `POST /campaigns/:id/comments`; approve and schedule are separate actions, both restricted to Marketing Manager. **Orchestration:** BullMQ delayed jobs — `campaign-orchestrate` (fires at `scheduled_for`; audience resolution → recipient fetch → grouped per-location send) + `ab-winner-select` (fires `ab_winner_delay_hours` after test sends; picks holdout winner). **Audience resolution:** hybrid push model — Campaign Service pages `GET /leads`, submits entity data to Audience Engine; pre-filter on known segment dimensions before submitting. **Multi-location:** group recipients by `location_id`; one `POST /emails/campaigns/send` call per location per send phase; each tracked as a separate `campaign_sends` row with `email_job_ref = "{campaign_id}:{location_id}[:{variant}]"` (UNIQUE, crash recovery idempotency). **A/B holdout:** configurable test split 1–49% (floor rounding); remainder is holdout (stored with `sent_at = NULL`); `ab-winner-select` picks winner from open rates after `ab_winner_delay_hours` (default 4), sends holdout the winning subject. **A/B full_split:** 50/50, both sent immediately, `ab_phase = 'complete'` at orchestration; no holdout; `ab_winner` computed at campaign completion from open counts. **Open tracking:** `ab_opens_a`/`ab_opens_b` incremented atomically on `email.opened`; winner = higher open rate; ties → A; both zero → A. **Crash recovery:** atomic DB transaction per location (`campaign_sends` + `campaign_recipients` bulk INSERT); skip guard via `email_job_ref`; empty snapshot → immediate `failed`; expired snapshot (48h TTL) → clear + re-resolve. **Conversion attribution:** SQS subscription to `lead.stage_changed`; 7-day window anchored to `occurred_at` (not SQS processing time); `ON CONFLICT (campaign_id, lead_id) DO NOTHING` (first conversion only); holdout attribution guards on `sent_at IS NOT NULL`. **`campaign.sent` event:** per `(campaign_id, location_id)`, carries `sent_count` — Analytics `CampaignSentHandler` increments `metrics_campaigns_daily.sent` by `sent_count` (not by 1 — second exception alongside `AdSpendSyncedHandler`). **Terminal status:** any successful send → `completed`/`completed_with_errors`; all failed/cancelled → `failed`. **Pending amendments:** Email Service spec (add `entity_type` + `entity_id` to `POST /emails/campaigns/send`); Lead Service spec (add `GET /leads?ids=...` batch endpoint); Analytics spec (document `sent_count` increment exception, add `email.opened`/`email.clicked` handlers); arch doc (add `campaign.sent` + `email.campaign_completed` to event table).

### Golden Rules (from arch doc)

1. Each service owns its DB schema — no cross-service table reads, all access through APIs or events.
2. Platform services never import product types — Automation Engine receives generic `{ entity_type, entity_id, event_type, payload }`.
3. Pipeline Engine only manages state — emits events; Automation Engine acts.
4. Platform UIs (`@platform/*`) call their own service's API directly from the browser (not proxied through CRM API Gateway). Auth uses the same Identity Service JWT.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript, Tailwind CSS, React Query |
| Backend | Node.js + TypeScript (Fastify) |
| Database | PostgreSQL (AWS RDS Multi-AZ) — shared cluster, one schema per service |
| Auth | Supabase Auth / Auth0, RBAC, SSO with EHR |
| SMS/Voice | Twilio |
| Email | SendGrid |
| AI | Claude Sonnet 4.6 (complex tasks) / Haiku 4.5 (high-volume) |
| Ads APIs | Google Ads API, Meta Marketing API |
| Event bus | AWS EventBridge |
| Job queue | BullMQ (Redis) — used by Automation Engine and Nurturing Engine for action dispatch and delayed step scheduling; Notification Service for TTL cleanup; Audience Engine for snapshot cleanup; Analytics Service for monthly partition maintenance; Identity Service for daily refresh token cleanup; Lead Service for SQS event worker |
| Infra | AWS us-east-1 (ECS Fargate, RDS, S3, CloudFront) |
| Monitoring | Datadog (APM, structured logs) |
| Monorepo | Turborepo |
| CI/CD | GitHub Actions |

## Core Product Concepts

**Three Patient Pipelines:**
1. New Patient (7 stages): New Lead → Contacted → Exam Scheduled → Exam Completed → Tx Presented → Contract Signed → Lost
2. In Treatment (3 stages): New Patient → In Treatment → Treatment Complete
3. In Retention (3 stages): Active Retention → Recall Due → Long-term Follow

**Roles:** Call Center Agent, Call Center Manager, Marketing Staff, Marketing Manager

**Lead channels:** Website forms, Google Ads, Facebook/Instagram Lead Ads, Twilio call tracking, referral links, walk-in/manual, chat widgets, Google Business Profile, CSV bulk import

**Key constraints:**
- No PHI at launch — leads are prospective patients, non-HIPAA initially
- Multi-location native (34 locations)
- Primary KPI: Cost per case start
- EHR integration is future (Ortho2 CSV bridge is temporary)
