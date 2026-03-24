# Ortho CRM — Platform Architecture Design

**Date:** 2026-03-24
**Status:** Draft
**Scope:** Full system architecture — platform layer, product layer, communication patterns, monorepo structure

---

## 1. Overview

Ortho CRM is built on a two-layer architecture: a **domain-agnostic platform layer** of reusable services, and a **product layer** of Ortho CRM-specific services that consume the platform. The platform layer can be reused in future products (same or different domains) by deploying new product services against the same platform.

**Key decisions:**
- Full SOA: every service independently deployable (21 total units)
- Single-tenant per deployment — reuse at code/image level, not infrastructure
- Monorepo (Turborepo) — one repo, per-service CI/CD pipelines
- Hybrid communication: async EventBridge events for state changes, sync REST for queries/commands
- Platform UIs ship as React component packages embedded in the CRM frontend shell

---

## 2. Architecture Layers

### 2.1 Platform Layer (12 services)

Domain-agnostic. No Ortho CRM concepts. Each service is separately deployed and owns its own DB schema.

| Service | Responsibility | DB Schema |
|---|---|---|
| **Messaging Service** | SMS/MMS/Voice via Twilio. Send, receive inbound webhooks, delivery status, number pool management, STOP/opt-out handling. | `platform_messaging` |
| **Email Service** | Delivery via SendGrid. Transactional + bulk. Bounce processing, unsubscribe handling, spam score check, send time optimization, dedicated sending domains. | `platform_email` |
| **Notification Service** | Real-time in-app notifications via WebSocket. Fan-out to user sessions on domain events. Push notification support (future). | `platform_notifications` |
| **Template Service** | Template storage + rendering engine. Multi-channel (email HTML/plain text, SMS). Versioning, A/B variants, merge tag resolution. Ships `@platform/template-ui` React component. | `platform_templates` |
| **Nurturing Engine** | Generic drip/lifecycle sequence runtime. Define steps (action type, delay, conditions), schedule execution, branching, A/B splits. No domain knowledge — entities enrolled by type + ID. Ships `@platform/sequence-ui` React component. | `platform_nurturing` |
| **Automation Engine** | Event-driven workflow runtime. Subscribes to domain events from EventBridge, evaluates trigger conditions, executes action chains (send message, update field, call webhook, branch). Ships `@platform/automation-ui` React component. | `platform_automation` |
| **Audience Engine** | Schema-agnostic segment filter evaluation. Define filter criteria against any entity type, evaluate membership, create audience snapshots for campaigns. Ships `@platform/audience-ui` React component. | `platform_audience` |
| **AI Service** | Claude API gateway. Prompt management, model routing (Claude Sonnet 4.6 for complex, Haiku 4.5 for high-volume), context injection, streaming, usage metering, response caching. | `platform_ai` |
| **Analytics Service** | Event ingestion pipeline. Metric aggregation, time-series storage, flexible query API. Domain-agnostic — any product publishes events and queries metrics. | `platform_analytics` |
| **Integration Hub** | External API connectors. OAuth credential storage, webhook ingestion + routing, polling jobs. Initial adapters: Google Ads API, Meta Marketing API. | `platform_integrations` |
| **Identity Service** | Authentication via Supabase Auth / Auth0. RBAC, multi-location scoping, SSO, API key management, session tokens. Shared across all products in a deployment. | `platform_identity` |
| **Media / File Service** | Upload handling, S3 storage, CDN delivery via CloudFront, access-controlled asset URLs, image optimization. | `platform_media` |

### 2.2 Product Layer — Ortho CRM (8 services)

Ortho-specific. Consume platform services via REST and events. Each independently deployed.

| Service | Responsibility | DB Schema |
|---|---|---|
| **Lead Service** | Lead records, attribution model (immutable first-touch), deduplication + merge logic, activity timeline, custom tags. Core entity store. | `crm_leads` |
| **Pipeline Engine** | State machine for 3 pipelines / 13 stages. Validates transitions, enforces time limits, publishes `stage.changed` events. Never executes actions directly. | `crm_pipeline` |
| **Conversation Service** | SMS inbox per location. Conversation threading, agent assignment, internal notes, escalation flags, read receipts. Bridges Messaging Service ↔ Lead records. | `crm_conversations` |
| **Campaign Service** | Email broadcast campaigns. Builder state machine, approval workflow, send orchestration. Delegates to Email + Audience + Template platform services. | `crm_campaigns` |
| **Referral Service** | Unique referral link generation per patient/doctor. Click tracking, conversion attribution, reward event logging, doctor portal, referral leaderboard. | `crm_referrals` |
| **Reporting Service** | Ortho-specific query layer over Analytics Service. Cost per case, ROAS, funnel rates, coordinator metrics, ad spend attribution. Report scheduling + PDF/CSV delivery via SendGrid. | `crm_reporting` |
| **Data Import Service** | Ortho2 CSV parsing, column auto-mapping, 5-tier match logic (phone → email → name+phone → name+DOB → manual), validation preview, import log, 2-hour bulk undo. | `crm_imports` |
| **CRM API Gateway** | REST API surface for frontend + EHR integration. JWT auth enforcement via Identity Service, RBAC, rate limiting, API versioning, API key management. | — |

### 2.3 Frontend (1 app)

| Unit | Responsibility |
|---|---|
| **CRM Web App** (`apps/crm/web`) | React 18 + TypeScript SPA. Tailwind CSS, React Query. Single app shell hosting coordinator view, manager view, analytics dashboard. Mounts platform UI components for template editing, sequence building, audience building, and automation rule editing. |

---

## 3. Communication Patterns

### 3.1 Async — EventBridge (state-change propagation)

Services publish domain events when state changes. Subscribers react independently. No direct coupling between publisher and subscriber.

**Events published by the product layer:**

| Event | Publisher | Subscribers |
|---|---|---|
| `lead.created` | Lead Service | Automation Engine, Analytics |
| `lead.stage_changed` | Pipeline Engine | Automation Engine, Analytics, Nurturing Engine |
| `lead.converted` | Pipeline Engine | Analytics, Reporting Service |
| `message.received` | Conversation Service | Automation Engine, Notification Service |
| `appointment.updated` | Lead Service | Pipeline Engine, Nurturing Engine |
| `referral.converted` | Referral Service | Lead Service, Analytics |
| `campaign.sent` | Campaign Service | Analytics |

**Events published by the platform layer:**

| Event | Publisher | Subscribers |
|---|---|---|
| `message.delivered` | Messaging Service | Conversation Service, Analytics |
| `message.failed` | Messaging Service | Automation Engine |
| `opt_out.received` | Messaging Service | Lead Service, Nurturing Engine |
| `email.bounced` | Email Service | Lead Service |
| `sequence.step_completed` | Nurturing Engine | Analytics |
| `workflow.triggered` | Automation Engine | Analytics |
| `ad_lead.received` | Integration Hub | Lead Service |

### 3.2 Sync — REST (queries and immediate commands)

Direct HTTP calls for operations requiring an immediate response.

| Call | Consumer → Provider | Purpose |
|---|---|---|
| `POST /templates/render` | Campaign Service, Nurturing Engine → Template Service | Merge tags, personalize content |
| `POST /messages/send` | Automation Engine, Conversation Service → Messaging Service | Send SMS immediately |
| `POST /emails/send` | Campaign Service, Automation Engine → Email Service | Send email immediately |
| `POST /audiences/evaluate` | Campaign Service → Audience Engine | Resolve segment to contact list |
| `POST /ai/complete` | Conversation Service, Automation Engine → AI Service | Draft reply, personalize message |
| `POST /sequences/enroll` | Pipeline Engine, Automation Engine → Nurturing Engine | Enroll entity in drip sequence |
| `GET /analytics/metrics` | Reporting Service → Analytics Service | Query aggregated metrics |

### 3.3 Golden Rules

1. **Each service owns its DB schema.** No cross-service table reads. All data access goes through APIs or events.
2. **Platform services never import product types.** The Automation Engine receives generic `{ entity_type, entity_id, event_type, payload }` — it has no concept of "lead" or "pipeline stage."
3. **Pipeline Engine only manages state.** It never sends messages or calls external services. It emits events; the Automation Engine acts.
4. **Platform UIs are React packages.** Exported from `packages/@platform/*`, imported by `apps/crm/web`. They call their own service's API directly — no proxy through the CRM API Gateway. Platform service endpoints are exposed to the browser with CORS configured for the CRM domain; auth is enforced via the same Identity Service JWT token the CRM shell already holds.

---

## 4. Monorepo Structure

**Tooling:** Turborepo. Node.js + TypeScript throughout. Fastify for all backend services.

```
ortho/
├── apps/
│   ├── platform/
│   │   ├── messaging/
│   │   ├── email/
│   │   ├── notification/
│   │   ├── template/
│   │   ├── nurturing/
│   │   ├── automation/
│   │   ├── audience/
│   │   ├── ai/
│   │   ├── analytics/
│   │   ├── integration-hub/
│   │   ├── identity/
│   │   └── media/
│   └── crm/
│       ├── lead/
│       ├── pipeline/
│       ├── conversation/
│       ├── campaign/
│       ├── referral/
│       ├── reporting/
│       ├── import/
│       ├── api-gateway/
│       └── web/                    # React SPA
├── packages/
│   ├── @ortho/types                # shared TypeScript interfaces for events + API contracts
│   ├── @ortho/event-bus            # typed EventBridge client with schema validation
│   ├── @ortho/auth-middleware      # Fastify JWT + RBAC plugin
│   ├── @ortho/db                   # Knex/Drizzle setup, migration runner, connection pool
│   ├── @ortho/logger               # structured JSON logging (Pino), Datadog-compatible
│   ├── @ortho/testing              # DB fixtures, EventBridge mock, HTTP test client, factories
│   ├── @platform/template-ui       # Template Editor React component
│   ├── @platform/sequence-ui       # Sequence Builder React component
│   ├── @platform/audience-ui       # Audience Builder React component
│   └── @platform/automation-ui     # Automation Rule Editor React component
├── infra/                          # IaC (AWS CDK or Terraform)
├── docs/
├── turbo.json
└── package.json
```

### 4.1 Per-service layout

Each `apps/**/<service>/` follows:

```
<service>/
├── src/
│   ├── routes/         # Fastify route handlers
│   ├── services/       # domain logic
│   ├── repositories/   # DB access (own schema only)
│   ├── events/         # EventBridge publishers
│   └── index.ts
├── migrations/         # owns its own schema migrations
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

### 4.2 CI/CD

- Turborepo detects changed `apps/*` on each PR. Only affected services run tests + lint.
- On merge to main: only changed services deploy to staging. Manual promote to production.
- Each service runs its own DB migrations as a pre-deploy step — only migrates its own schema.
- All 21 services share the same ECS cluster but run as independent task definitions.

---

## 5. Infrastructure

| Component | Technology | Notes |
|---|---|---|
| Container runtime | AWS ECS Fargate | One task definition per service. Independent scaling. |
| Database | PostgreSQL on AWS RDS Multi-AZ | Shared cluster, one schema per service. |
| Event bus | AWS EventBridge | All async cross-service events. |
| Frontend hosting | S3 + CloudFront | React SPA + static assets. |
| File storage | S3 | Per-service prefix paths. |
| Monitoring | Datadog | Distributed tracing (APM), structured logs, alerts on API errors / Twilio failures / slow queries. |
| CI/CD | GitHub Actions + Turborepo | Per-service pipelines. |
| Region | AWS us-east-1 | Shared VPC with future EHR. |

---

## 6. Key Design Constraints

- **No PHI at launch.** Leads are prospective patients. CRM operates outside HIPAA until EHR integration.
- **EHR-ready.** Lead Service data model and Pipeline Engine events are designed to cleanly accept EHR integration events (`appointment_created`, `contract_signed`, etc.) when the EHR ships. The CSV import bridge is temporary.
- **Multi-location native.** All product services enforce location-scoped access via Identity Service RBAC. 34 locations from day one.
- **Platform reusability.** Platform services have no dependency on `apps/crm/*`. A new product can be built under `apps/<new-product>/` and consume the same platform services without modification.
