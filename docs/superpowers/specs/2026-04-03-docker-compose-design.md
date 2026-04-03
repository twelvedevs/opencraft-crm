# Docker Compose — Local Development Setup

**Date:** 2026-04-03
**Status:** Approved
**Scope:** docker-compose configuration for local development — infrastructure tier and optional full platform services tier

---

## 1. Overview

A single `docker-compose.yml` at the monorepo root provides a hybrid local dev setup:

- **Infra tier (always-on):** Postgres, Redis, Supabase GoTrue, MailHog — no profile required
- **Services tier (optional):** All 11 platform services + their migration companions — gated behind `--profile services`

Primary workflows:

```bash
docker compose up                        # infra only — develop one service locally with npm run dev
docker compose --profile services up     # full platform stack — integration testing
```

---

## 2. Infrastructure Tier

Always started, no profile required.

| Container | Image | Ports | Purpose |
|---|---|---|---|
| `postgres` | `postgres:17-alpine` | 5432 | Shared cluster, single `ortho` DB, separate schema per service |
| `redis` | `redis:7-alpine` | 6379 | BullMQ queues, event bus (Redis Streams), caching, pub/sub |
| `supabase_auth` | `supabase/gotrue` | 9999 | Auth backend for Identity Service (`AUTH_PROVIDER=supabase`) |
| `mailhog` | `mailhog/mailhog` | 1025 (SMTP), 8025 (UI) | Catches GoTrue transactional emails in dev |

### 2.1 Postgres Initialization

A `docker/init-db.sql` script mounts at `/docker-entrypoint-initdb.d/` and runs once on first container start. It pre-creates all service schemas and the GoTrue `auth` schema:

```sql
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS platform_identity;
CREATE SCHEMA IF NOT EXISTS platform_ai;
CREATE SCHEMA IF NOT EXISTS platform_analytics;
CREATE SCHEMA IF NOT EXISTS platform_audience;
CREATE SCHEMA IF NOT EXISTS platform_automation;
CREATE SCHEMA IF NOT EXISTS platform_email;
CREATE SCHEMA IF NOT EXISTS platform_integration;
CREATE SCHEMA IF NOT EXISTS platform_messaging;
CREATE SCHEMA IF NOT EXISTS platform_notifications;
CREATE SCHEMA IF NOT EXISTS platform_nurturing;
CREATE SCHEMA IF NOT EXISTS platform_templates;
```

### 2.2 GoTrue Configuration

GoTrue is configured for local dev:
- `GOTRUE_MAILER_AUTOCONFIRM=true` — skip email confirmation
- SMTP pointed at MailHog (`mailhog:1025`)
- JWT secret shared with Identity Service via `GoTrue__JWT_Secret` env var
- Runs its own schema migrations on startup against the `auth` schema

### 2.3 Healthchecks

All infra containers expose healthchecks so `depends_on: condition: service_healthy` works reliably:

- **postgres:** `pg_isready -U ${Postgres__User} -d ${Postgres__DB}`
- **redis:** `redis-cli ping`
- **supabase_auth:** `GET /health` on port 9999

---

## 3. Platform Services Tier

All 11 services are tagged `profile: services`. Each service has a `_migrations` companion that runs once and exits before the main service starts.

| Service | Migrations companion | Port |
|---|---|---|
| `identity` | `identity_migrations` | 3100 |
| `ai` | `ai_migrations` | 3101 |
| `template` | `template_migrations` | 3102 |
| `notification` | `notification_migrations` | 3103 |
| `audience` | `audience_migrations` | 3104 |
| `analytics` | `analytics_migrations` | 3105 |
| `messaging` | `messaging_migrations` | 3106 |
| `email` | `email_migrations` | 3107 |
| `nurturing` | `nurturing_migrations` | 3108 |
| `automation` | `automation_migrations` | 3109 |
| `integration_hub` | `integration_hub_migrations` | 3110 |

### 3.1 Dependency Chain

```
postgres (healthy)
  └── identity_migrations (completed_successfully)
        └── identity (healthy)
              └── [services that depend on identity]

redis (healthy)
  └── [all services]
```

Migration services inherit the same profile as their parent service — they run whenever the main service runs.

### 3.2 Event Bus in Dev

All services set `EVENT_BUS_DRIVER=redis`. The `@ortho/event-bus` Redis Streams driver handles both publishing and consuming. No AWS EventBridge or SQS is required locally.

Each subscribing service gets a unique `EVENT_BUS_CONSUMER_GROUP`:

| Service | Consumer group |
|---|---|
| `notification` | `notification-service` |
| `analytics` | `analytics-service` |
| `email` | `email-service` |
| `nurturing` | `nurturing-engine` |
| `automation` | `automation-engine` |
| `integration_hub` | `integration-hub` |

---

## 4. Dockerfile Strategy

### 4.1 Production vs Dev Dockerfiles

The existing per-service `Dockerfile` is **production-only** — it expects a pre-built `dist/` and is used by CI/CD after Turborepo builds. It is not modified.

A new `docker/Dockerfile.dev` at the monorepo root handles compose builds. It uses a multi-stage build with `SERVICE_PATH` as a build arg, allowing one Dockerfile to build any service.

```dockerfile
ARG SERVICE_PATH

# Stage 1: build
FROM node:24-alpine AS builder
WORKDIR /repo
COPY packages/ ./packages/
COPY ${SERVICE_PATH}/package*.json ./${SERVICE_PATH}/
WORKDIR /repo/${SERVICE_PATH}
RUN npm ci
COPY ${SERVICE_PATH}/ ./${SERVICE_PATH}/
RUN npm run build

# Stage 2: runtime
FROM node:24-alpine
WORKDIR /app
COPY --from=builder /repo/${SERVICE_PATH}/dist ./dist
COPY --from=builder /repo/${SERVICE_PATH}/node_modules ./node_modules
COPY --from=builder /repo/${SERVICE_PATH}/knexfile.ts ./knexfile.ts
CMD ["node", "dist/index.js"]
```

The monorepo root is the build context (`context: .`) so `file:` workspace dependencies in `package.json` (e.g. `@ortho/auth-middleware`) resolve correctly.

### 4.2 Service Definition Pattern

```yaml
identity:
  build:
    context: .
    dockerfile: docker/Dockerfile.dev
    args:
      SERVICE_PATH: apps/platform/identity
  image: ortho-identity   # named so _migrations can reuse it
  profiles: [services]
  ports:
    - "3100:3100"
  environment:
    PORT: "3100"
    DATABASE_URL: ${Identity_Service__DB_URL}
    REDIS_URL: ${Redis__URL}
    AUTH_PROVIDER: supabase
    SUPABASE_URL: ${GoTrue__URL}
    SUPABASE_SERVICE_ROLE_KEY: ${GoTrue__Service_Role_Key}
    IDENTITY_PRIVATE_KEY: ${Identity__Private_Key}
    IDENTITY_JWKS_KEYS: ${Identity__JWKS_Keys}
    INTERNAL_API_SECRET: ${Identity__Internal_API_Secret}
    CORS_ORIGIN: ${Identity__CORS_Origin}
  depends_on:
    identity_migrations:
      condition: service_completed_successfully
    redis:
      condition: service_healthy

identity_migrations:
  image: ortho-identity   # reuses the built image, no rebuild
  command: npm run migrate
  profiles: [services]
  environment:
    DATABASE_URL: ${Identity_Service__DB_URL}
  depends_on:
    postgres:
      condition: service_healthy
```

### 4.3 Migration Script

Each service's `package.json` must include a `migrate` script. The `--knexfile` path varies per service — some have `knexfile.ts` at the service root, others at `migrations/knexfile.ts`:

```json
"migrate": "knex migrate:latest --knexfile knexfile.ts"
// or
"migrate": "knex migrate:latest --knexfile migrations/knexfile.ts"
```

The implementation step must verify the correct path for each of the 11 services. This is the command the `_migrations` companion runs.

---

## 5. Environment Management

### 5.1 Files

| File | Committed | Purpose |
|---|---|---|
| `.env.example` | Yes | All variables with placeholder values and comments |
| `.env` | No (gitignored) | Developer's local copy with real keys |

Docker Compose loads `.env` automatically. No `env_file:` keys in the compose file — all service env vars are declared explicitly under `environment:`.

### 5.2 Naming Convention

- **CamelCase with double-underscore namespace:** `Service_Name__Var_Name`
- **Variable substitution** for composed values (URLs, connection strings)
- **Primitive vars first** (host, port, credentials), derived vars (URLs) after

This makes camelCase vars visually distinct from the `UPPER_SNAKE_CASE` service env vars in the compose file, and makes var reuse across services explicit.

### 5.3 `.env.example` Structure

```bash
# ── Postgres ──────────────────────────────────────────────────────────────────
Postgres__Host=postgres
Postgres__Port=5432
Postgres__User=ortho
Postgres__Password=changeme
Postgres__DB=ortho

# ── Redis ─────────────────────────────────────────────────────────────────────
Redis__Host=redis
Redis__Port=6379
Redis__URL=redis://${Redis__Host}:${Redis__Port}

# ── GoTrue (Supabase Auth) ────────────────────────────────────────────────────
GoTrue__Host=supabase-auth
GoTrue__Port=9999
GoTrue__URL=http://${GoTrue__Host}:${GoTrue__Port}
GoTrue__JWT_Secret=super-secret-jwt-token-with-at-least-32-chars
GoTrue__Service_Role_Key=PLACEHOLDER

# ── MailHog ───────────────────────────────────────────────────────────────────
MailHog__Host=mailhog
MailHog__SMTP_Port=1025
MailHog__UI_Port=8025

# ── Identity Service ──────────────────────────────────────────────────────────
Identity_Service__Host=identity
Identity_Service__Port=3100
Identity_Service__URL=http://${Identity_Service__Host}:${Identity_Service__Port}
Identity_Service__DB_Name=platform_identity
Identity_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
Identity__Private_Key=PLACEHOLDER    # generate with scripts/dev/gen-keys.sh
Identity__JWKS_Keys=[]               # generate with scripts/dev/gen-keys.sh
Identity__Internal_API_Secret=dev-internal-secret
Identity__CORS_Origin=http://localhost:3000

# ── AI Service ────────────────────────────────────────────────────────────────
Ai_Service__Host=ai
Ai_Service__Port=3101
Ai_Service__URL=http://${Ai_Service__Host}:${Ai_Service__Port}
Ai_Service__DB_Name=platform_ai
Ai_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
# ── Template Service ──────────────────────────────────────────────────────────
Template_Service__Host=template
Template_Service__Port=3102
Template_Service__URL=http://${Template_Service__Host}:${Template_Service__Port}
Template_Service__DB_Name=platform_templates
Template_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}Template_Service__JWT_Secret=dev-template-jwt-secret

# ── Notification Service ──────────────────────────────────────────────────────
Notification_Service__Host=notification
Notification_Service__Port=3103
Notification_Service__URL=http://${Notification_Service__Host}:${Notification_Service__Port}
Notification_Service__DB_Name=platform_notifications
Notification_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}Notification_Service__JWT_HMAC_Secret=dev-notification-jwt-secret

# ── Audience Engine ───────────────────────────────────────────────────────────
Audience_Service__Host=audience
Audience_Service__Port=3104
Audience_Service__URL=http://${Audience_Service__Host}:${Audience_Service__Port}
Audience_Service__DB_Name=platform_audience
Audience_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
# ── Analytics Service ─────────────────────────────────────────────────────────
Analytics_Service__Host=analytics
Analytics_Service__Port=3105
Analytics_Service__URL=http://${Analytics_Service__Host}:${Analytics_Service__Port}
Analytics_Service__DB_Name=platform_analytics
Analytics_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}Analytics_Service__Admin_Recompute_Key=dev-recompute-key
Analytics_Service__Consumer_Group=analytics-service

# ── Messaging Service ─────────────────────────────────────────────────────────
Messaging_Service__Host=messaging
Messaging_Service__Port=3106
Messaging_Service__URL=http://${Messaging_Service__Host}:${Messaging_Service__Port}
Messaging_Service__DB_Name=platform_messaging
Messaging_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}Messaging_Service__Consumer_Group=messaging-service
Twilio__Account_SID=AC_PLACEHOLDER
Twilio__Auth_Token=PLACEHOLDER
Twilio__Status_Callback_URL=http://localhost:${Messaging_Service__Port}/webhooks/twilio/status

# ── Email Service ─────────────────────────────────────────────────────────────
Email_Service__Host=email
Email_Service__Port=3107
Email_Service__URL=http://${Email_Service__Host}:${Email_Service__Port}
Email_Service__DB_Name=platform_email
Email_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}Email_Service__Consumer_Group=email-service
SendGrid__API_Key=SG.PLACEHOLDER
SendGrid__Webhook_Signing_Key_Secret_ARN=PLACEHOLDER

# ── Nurturing Engine ──────────────────────────────────────────────────────────
Nurturing_Service__Host=nurturing
Nurturing_Service__Port=3108
Nurturing_Service__URL=http://${Nurturing_Service__Host}:${Nurturing_Service__Port}
Nurturing_Service__DB_Name=platform_nurturing
Nurturing_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}Nurturing_Service__Consumer_Group=nurturing-engine

# ── Automation Engine ─────────────────────────────────────────────────────────
Automation_Service__Host=automation
Automation_Service__Port=3109
Automation_Service__URL=http://${Automation_Service__Host}:${Automation_Service__Port}
Automation_Service__DB_Name=platform_automation
Automation_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}Automation_Service__Consumer_Group=automation-engine

# ── Integration Hub ───────────────────────────────────────────────────────────
Integration_Hub__Host=integration-hub
Integration_Hub__Port=3110
Integration_Hub__URL=http://${Integration_Hub__Host}:${Integration_Hub__Port}
Integration_Hub__DB_Name=platform_integration
Integration_Hub__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}Integration_Hub__Consumer_Group=integration-hub
Integration_Hub__Secrets_Provider=env
Integration_Hub__JWT_Mode=static
Integration_Hub__OAuth_State_Secret=dev-oauth-state-secret
Google_Ads__Client_ID=PLACEHOLDER
Google_Ads__Client_Secret=PLACEHOLDER
Google_Ads__Developer_Token=PLACEHOLDER
Google_Ads__Redirect_URI=http://localhost:${Integration_Hub__Port}/oauth/google/callback
Google_Ads__Webhook_Verify_Token=PLACEHOLDER
Meta__App_ID=PLACEHOLDER
Meta__App_Secret=PLACEHOLDER
Meta__Redirect_URI=http://localhost:${Integration_Hub__Port}/oauth/meta/callback
Meta__Webhook_Verify_Token=PLACEHOLDER
```

---

## 6. Developer Experience

### 6.1 Scripts

```
scripts/dev/
├── up.sh          # docker compose up -d (infra only)
├── up-all.sh      # docker compose --profile services up -d
├── down.sh        # docker compose down
├── logs.sh        # docker compose logs -f [optional: service name]
├── gen-keys.sh    # generates IDENTITY_PRIVATE_KEY + IDENTITY_JWKS_KEYS, prints to stdout
└── reset.sh       # docker compose down -v && docker compose up -d (clean slate)
```

### 6.2 First-Time Setup

```bash
# 1. Copy env template
cp .env.example .env

# 2. Generate identity keys and paste output into .env
./scripts/dev/gen-keys.sh

# 3. Fill in real API keys for services you intend to exercise
#    (Twilio, SendGrid, Google Ads, Meta) — leave others as PLACEHOLDER

# 4. Start infra
./scripts/dev/up.sh

# 5a. Develop a single service locally
cd apps/platform/identity && npm run dev

# 5b. OR run the full platform stack
./scripts/dev/up-all.sh

# 6. First-time: seed super admin (once, after identity is up)
cd apps/platform/identity && node scripts/seed-super-admin.ts
```

### 6.3 Documentation

Setup instructions live at `docs/development/local-dev.md`.

---

## 7. File Layout

```
/                              ← monorepo root
├── docker-compose.yml
├── .env.example               ← committed
├── .env                       ← gitignored
├── docker/
│   ├── Dockerfile.dev         ← multi-stage, parameterized via SERVICE_PATH build arg
│   └── init-db.sql            ← creates all schemas on first postgres start
├── scripts/dev/
│   ├── up.sh
│   ├── up-all.sh
│   ├── down.sh
│   ├── logs.sh
│   ├── gen-keys.sh
│   └── reset.sh
└── docs/development/
    └── local-dev.md           ← first-time setup guide
```

---

## 8. Out of Scope

- CRM layer services (no `apps/crm/` exists yet) — added when built
- Frontend (`apps/crm/web`) — no compose entry until React app exists
- Production deployment — existing per-service `Dockerfile` and CI/CD unchanged
- LocalStack — not needed; Redis Streams replaces EventBridge/SQS in dev
- Monitoring/Datadog — not wired in local dev
