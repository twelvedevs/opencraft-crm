# Documentation Navigator

## Product & Architecture

| Document | Description |
|----------|-------------|
| [00-prd-1.md](00-prd-1.md) | Full PRD v1.0 — authoritative source for product decisions |
| [01-platform-arch-design.md](01-platform-arch-design.md) | Platform architecture design — authoritative source for technical decisions |

## Architecture Decisions

| Document | Description |
|----------|-------------|
| [arch/adr-event-bus.md](arch/adr-event-bus.md) | ADR: Event bus selection and design |
| [arch/adr-logger.md](arch/adr-logger.md) | ADR: Logger selection and configuration |
| [arch/adr-interpolator.md](arch/adr-interpolator.md) | ADR: `@ortho/interpolator` — field interpolation & active hours |
| [arch/adr-filter-engine.md](arch/adr-filter-engine.md) | ADR: `@platform/filter-engine` — shared filter evaluation package |
| [arch/adr-auth-middleware.md](arch/adr-auth-middleware.md) | ADR: `@ortho/auth-middleware` — JWT verification and RBAC Fastify plugin |

## Component Design Specs (`docs/superpowers/specs/`)

All specs are **Approved** unless noted otherwise.

### Platform Layer

| Spec | Memory |
|------|--------|
| [automation-engine-design.md](superpowers/specs/2026-03-24-automation-engine-design.md) | [memories/automation](memories/) |
| [nurturing-engine-design.md](superpowers/specs/2026-03-25-nurturing-engine-design.md) | — |
| [messaging-service-design.md](superpowers/specs/2026-03-25-messaging-service-design.md) | [memories/messaging-service.md](memories/messaging-service.md) |
| [email-service-design.md](superpowers/specs/2026-03-25-email-service-design.md) | — |
| [email-service-updated-design.md](superpowers/specs/2026-03-29-email-service-updated-design.md) | — |
| [notification-service-design.md](superpowers/specs/2026-03-25-notification-service-design.md) | [memories/notification-service.md](memories/notification-service.md) |
| [notification-service-updated-design.md](superpowers/specs/2026-03-30-notification-service-updated-design.md) _(supersedes above)_ | [memories/notification-service.md](memories/notification-service.md) |
| [template-service-design.md](superpowers/specs/2026-03-25-template-service-design.md) | [memories/template-service.md](memories/template-service.md) |
| [audience-engine-design.md](superpowers/specs/2026-03-25-audience-engine-design.md) | [memories/audience-engine.md](memories/audience-engine.md) |
| [ai-service-design.md](superpowers/specs/2026-03-25-ai-service-design.md) | [memories/ai-service.md](memories/ai-service.md) |
| [analytics-service-design.md](superpowers/specs/2026-03-25-analytics-service-design.md) | [memories/analytics-service.md](memories/analytics-service.md) |
| [integration-hub-design.md](superpowers/specs/2026-03-25-integration-hub-design.md) | [memories/integration-hub.md](memories/integration-hub.md) |
| [media-service-design.md](superpowers/specs/2026-03-25-media-service-design.md) | [memories/media-service.md](memories/media-service.md) |
| [identity-service-design.md](superpowers/specs/2026-03-25-identity-service-design.md) _(superseded)_ | [memories/identity-service.md](memories/identity-service.md) |
| [identity-service-updated-design.md](superpowers/specs/2026-04-02-identity-service-updated-design.md) _(supersedes above)_ | [memories/identity-service.md](memories/identity-service.md) |

### Ortho CRM Layer

| Spec | Memory |
|------|--------|
| [lead-service-design.md](superpowers/specs/2026-03-25-lead-service-design.md) _(superseded)_ | [memories/lead-service.md](memories/lead-service.md) |
| [lead-service-updated-design.md](superpowers/specs/2026-04-06-lead-service-updated-design.md) _(supersedes above)_ | [memories/lead-service.md](memories/lead-service.md) |
| [pipeline-engine-design.md](superpowers/specs/2026-03-25-pipeline-engine-design.md) | [memories/pipeline-engine.md](memories/pipeline-engine.md) |
| [conversation-service-design.md](superpowers/specs/2026-03-25-conversation-service-design.md) | [memories/conversation-service.md](memories/conversation-service.md) |
| [campaign-service-design.md](superpowers/specs/2026-03-25-campaign-service-design.md) | [memories/campaign-service.md](memories/campaign-service.md) |
| [referral-service-design.md](superpowers/specs/2026-03-25-referral-service-design.md) | [memories/referral-service.md](memories/referral-service.md) |
| [reporting-service-design.md](superpowers/specs/2026-03-25-reporting-service-design.md) | [memories/reporting-service.md](memories/reporting-service.md) |
| [data-import-service-design.md](superpowers/specs/2026-03-25-data-import-service-design.md) | [memories/data-import-service.md](memories/data-import-service.md) |
| [crm-api-gateway-design.md](superpowers/specs/2026-03-25-crm-api-gateway-design.md) | [memories/crm-api-gateway.md](memories/crm-api-gateway.md) |
| [crm-web-app-design.md](superpowers/specs/2026-03-25-crm-web-app-design.md) | [memories/crm-web-app.md](memories/crm-web-app.md) |

### Shared Infrastructure

| Spec | Description |
|------|-------------|
| [event-bus-adapter-design.md](superpowers/specs/2026-03-29-event-bus-adapter-design.md) | EventBridge adapter design |
| [docker-compose-design.md](superpowers/specs/2026-04-03-docker-compose-design.md) | Local development docker-compose setup |

## Development Guides (`docs/development/`)

| Guide | Description |
|-------|-------------|
| [local-dev.md](development/local-dev.md) | Local development setup with docker-compose |

## Implementation Plans (`docs/superpowers/plans/`)

| Plan | Description |
|------|-------------|
| [2026-03-27-automation-engine-phase-1.md](superpowers/plans/2026-03-27-automation-engine-phase-1.md) | Automation Engine — Phase 1 implementation plan |
| [2026-03-27-automation-engine-phases.md](superpowers/specs/2026-03-27-automation-engine-phases.md) | Automation Engine — phased rollout spec |
| [2026-03-29-email-service-phases.md](superpowers/specs/2026-03-29-email-service-phases.md) | Email Service — phased rollout spec |

## Key Design Decisions (memories/)

Distilled API/design decisions from spec sessions — read before working on a component.

| Service | File |
|---------|------|
| Messaging Service | [memories/messaging-service.md](memories/messaging-service.md) |
| Notification Service | [memories/notification-service.md](memories/notification-service.md) |
| Template Service | [memories/template-service.md](memories/template-service.md) |
| Audience Engine | [memories/audience-engine.md](memories/audience-engine.md) |
| AI Service | [memories/ai-service.md](memories/ai-service.md) |
| Analytics Service | [memories/analytics-service.md](memories/analytics-service.md) |
| Integration Hub | [memories/integration-hub.md](memories/integration-hub.md) |
| Media Service | [memories/media-service.md](memories/media-service.md) |
| Identity Service | [memories/identity-service.md](memories/identity-service.md) |
| Lead Service | [memories/lead-service.md](memories/lead-service.md) |
| Pipeline Engine | [memories/pipeline-engine.md](memories/pipeline-engine.md) |
| Conversation Service | [memories/conversation-service.md](memories/conversation-service.md) |
| Campaign Service | [memories/campaign-service.md](memories/campaign-service.md) |
| Referral Service | [memories/referral-service.md](memories/referral-service.md) |
| Reporting Service | [memories/reporting-service.md](memories/reporting-service.md) |
| Data Import Service | [memories/data-import-service.md](memories/data-import-service.md) |
| CRM API Gateway | [memories/crm-api-gateway.md](memories/crm-api-gateway.md) |
| CRM Web App | [memories/crm-web-app.md](memories/crm-web-app.md) |
