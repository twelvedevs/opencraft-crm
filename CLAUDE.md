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
  - `2026-03-25-email-service-design.md` — Draft
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
  - `2026-03-25-campaign-service-design.md` — Draft
  - `2026-03-25-reporting-service-design.md` — Draft
  - `2026-03-25-referral-service-design.md` — Draft
  - `2026-03-25-data-import-service-design.md` — Draft
  - `2026-03-25-crm-api-gateway-design.md` — Draft
  - `2026-03-25-crm-web-app-design.md` — Draft
- `docs/memories/` — Per-component key API/design decisions distilled from spec sessions (one file per service). Read the relevant file before working on or discussing a component.

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
