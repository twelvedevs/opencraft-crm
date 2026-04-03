# Docker Compose — Local Development Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a single `docker-compose.yml` that provides a hybrid local dev environment — infra always-on, all 11 platform services optionally runnable via `--profile services`.

**Architecture:** Single compose file with Docker Compose profiles. Infra tier (postgres, redis, supabase/gotrue, nginx proxy, mailhog) starts with no profile. Services tier (11 platform services + 11 `_migrations` companions) starts with `--profile services`. A shared `docker/Dockerfile.dev` builds any service from source using a `SERVICE_PATH` build arg, with the monorepo root as context so `file:` workspace dependencies resolve correctly.

**Tech Stack:** Docker Compose v2, postgres:17-alpine, redis:7-alpine, supabase/gotrue, nginx:alpine, mailhog/mailhog, Node.js 24, tsx (TypeScript runner for migrations)

---

## Pre-flight: Key Findings

Read this before starting. These were discovered during planning by reading the actual source code:

1. **Knexfile inconsistency** — 3 services have knexfiles missing `searchPath`/`schemaName` (tables would land in `public`): `ai`, `audience`, `messaging`. 2 services have no knexfile at all: `email`, `identity`. Task 1 fixes all 5.

2. **Integration Hub schema name** — the knexfile uses `platform_integrations` (with an 's'). Use that everywhere, not `platform_integration`.

3. **Analytics requires `SQS_QUEUE_URL`** — it's a required field in `env.ts` even though the actual event consumer uses `createEventBus()` with Redis Streams. Set it to a dummy string in dev.

4. **Automation won't receive events in dev** — its event consumer is a custom `SqsConsumer` class (not `createEventBus()`). There's no Redis streams fallback. Automation starts fine; it just won't receive events unless SQS is configured. Manually trigger rules via API during local dev.

5. **GoTrue path prefix** — `@supabase/supabase-js` makes requests to `{SUPABASE_URL}/auth/v1/*`. GoTrue serves directly at `/token`, `/user`, etc. (no prefix). Solution: an `nginx` proxy container rewrites `/auth/v1/*` → `/*`.

6. **`migrate` script uses tsx** — migration files are `.ts` (not compiled). The migrate command must invoke tsx; the Docker image includes dev dependencies so tsx is available.

---

## File Map

```
/ (monorepo root)
├── docker-compose.yml                              CREATE
├── .env.example                                    CREATE
├── .gitignore                                      CREATE (none exists at root)
├── docker/
│   ├── Dockerfile.dev                              CREATE
│   ├── init-db.sql                                 CREATE
│   └── nginx-supabase.conf                         CREATE
├── scripts/dev/
│   ├── up.sh                                       CREATE
│   ├── up-all.sh                                   CREATE
│   ├── down.sh                                     CREATE
│   ├── logs.sh                                     CREATE
│   ├── reset.sh                                    CREATE
│   ├── gen-keys.ts                                 CREATE
│   └── gen-keys.sh                                 CREATE
├── docs/development/
│   └── local-dev.md                                CREATE
├── apps/platform/ai/knexfile.ts                    MODIFY (add searchPath + schemaName)
├── apps/platform/audience/knexfile.ts              MODIFY (add searchPath + schemaName)
├── apps/platform/messaging/knexfile.ts             MODIFY (add searchPath + schemaName)
├── apps/platform/email/migrations/knexfile.ts      CREATE
├── apps/platform/identity/migrations/knexfile.ts   CREATE
└── apps/platform/{all 11}/package.json             MODIFY (add "migrate" script each)
```

---

## Task 1: Fix Knexfiles

**Files:**
- Modify: `apps/platform/ai/knexfile.ts`
- Modify: `apps/platform/audience/knexfile.ts`
- Modify: `apps/platform/messaging/knexfile.ts`
- Create: `apps/platform/email/migrations/knexfile.ts`
- Create: `apps/platform/identity/migrations/knexfile.ts`

- [ ] **Step 1: Update `apps/platform/ai/knexfile.ts`**

Replace the entire file with:

```typescript
import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_ai', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'platform_ai',
    tableName: 'knex_migrations',
  },
};

export default config;
```

- [ ] **Step 2: Update `apps/platform/audience/knexfile.ts`**

Replace the entire file with:

```typescript
import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_audience', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'platform_audience',
    tableName: 'knex_migrations',
  },
};

export default config;
```

- [ ] **Step 3: Update `apps/platform/messaging/knexfile.ts`**

Replace the entire file with:

```typescript
import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_messaging', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'platform_messaging',
    tableName: 'knex_migrations',
  },
};

export default config;
```

- [ ] **Step 4: Create `apps/platform/email/migrations/knexfile.ts`**

```typescript
import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_email', 'public'],
  migrations: {
    directory: '.',
    schemaName: 'platform_email',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
```

- [ ] **Step 5: Create `apps/platform/identity/migrations/knexfile.ts`**

```typescript
import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_identity', 'public'],
  migrations: {
    directory: '.',
    schemaName: 'platform_identity',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
```

- [ ] **Step 6: Commit**

```bash
git add apps/platform/ai/knexfile.ts \
        apps/platform/audience/knexfile.ts \
        apps/platform/messaging/knexfile.ts \
        apps/platform/email/migrations/knexfile.ts \
        apps/platform/identity/migrations/knexfile.ts
git commit -m "chore: add missing knexfile schema config for docker-compose migrations"
```

---

## Task 2: Add Migrate Scripts to All 11 Services

**Files:** `package.json` in each of the 11 service directories

The migrate command uses `npx tsx` because migration files are TypeScript and ESM — Node can't execute them natively. The `--knexfile` path is relative to the service root directory.

- [ ] **Step 1: Add migrate script to `apps/platform/ai/package.json`**

Add to `"scripts"`:
```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile knexfile.ts"
```

- [ ] **Step 2: Add migrate script to `apps/platform/analytics/package.json`**

```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile migrations/knexfile.ts"
```

- [ ] **Step 3: Add migrate script to `apps/platform/audience/package.json`**

```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile knexfile.ts"
```

- [ ] **Step 4: Add migrate script to `apps/platform/automation/package.json`**

```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile migrations/knexfile.ts"
```

- [ ] **Step 5: Add migrate script to `apps/platform/email/package.json`**

```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile migrations/knexfile.ts"
```

- [ ] **Step 6: Add migrate script to `apps/platform/identity/package.json`**

```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile migrations/knexfile.ts"
```

- [ ] **Step 7: Add migrate script to `apps/platform/integration-hub/package.json`**

```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile migrations/knexfile.ts"
```

- [ ] **Step 8: Add migrate script to `apps/platform/messaging/package.json`**

```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile knexfile.ts"
```

- [ ] **Step 9: Add migrate script to `apps/platform/notification/package.json`**

```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile migrations/knexfile.ts"
```

- [ ] **Step 10: Add migrate script to `apps/platform/nurturing/package.json`**

```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile migrations/knexfile.ts"
```

- [ ] **Step 11: Add migrate script to `apps/platform/template/package.json`**

```json
"migrate": "npx tsx node_modules/knex/bin/cli.js migrate:latest --knexfile migrations/knexfile.ts"
```

- [ ] **Step 12: Commit**

```bash
git add apps/platform/ai/package.json \
        apps/platform/analytics/package.json \
        apps/platform/audience/package.json \
        apps/platform/automation/package.json \
        apps/platform/email/package.json \
        apps/platform/identity/package.json \
        apps/platform/integration-hub/package.json \
        apps/platform/messaging/package.json \
        apps/platform/notification/package.json \
        apps/platform/nurturing/package.json \
        apps/platform/template/package.json
git commit -m "chore: add migrate script to all platform services"
```

---

## Task 3: Create Docker Infrastructure Files

**Files:**
- Create: `docker/Dockerfile.dev`
- Create: `docker/init-db.sql`
- Create: `docker/nginx-supabase.conf`

- [ ] **Step 1: Create `docker/Dockerfile.dev`**

```dockerfile
# Multi-stage dev build. Build any platform service via SERVICE_PATH build arg.
# Usage: docker build --build-arg SERVICE_PATH=apps/platform/identity -f docker/Dockerfile.dev .
ARG SERVICE_PATH

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
ARG SERVICE_PATH

WORKDIR /repo

# Copy workspace packages so file: dependencies resolve
COPY packages/ ./packages/

# Install service deps (including devDeps — tsx needed for migrations)
COPY ${SERVICE_PATH}/package*.json ./${SERVICE_PATH}/
WORKDIR /repo/${SERVICE_PATH}
RUN npm ci

# Copy source and compile
COPY ${SERVICE_PATH}/ ./${SERVICE_PATH}/
WORKDIR /repo/${SERVICE_PATH}
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:24-alpine
ARG SERVICE_PATH

WORKDIR /app

# Copy the entire service dir: dist/ (compiled), node_modules/ (deps + tsx),
# migrations/ (*.ts files for knex migrate), knexfile.ts (if at service root)
COPY --from=builder /repo/${SERVICE_PATH} ./

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create `docker/init-db.sql`**

This script runs once on first Postgres container start via `/docker-entrypoint-initdb.d/`.

```sql
-- Create all service schemas upfront so migration services can run in any order
-- without "schema does not exist" errors.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE SCHEMA IF NOT EXISTS platform_identity;
CREATE SCHEMA IF NOT EXISTS platform_ai;
CREATE SCHEMA IF NOT EXISTS platform_analytics;
CREATE SCHEMA IF NOT EXISTS platform_audience;
CREATE SCHEMA IF NOT EXISTS platform_automation;
CREATE SCHEMA IF NOT EXISTS platform_email;
CREATE SCHEMA IF NOT EXISTS platform_integrations;
CREATE SCHEMA IF NOT EXISTS platform_messaging;
CREATE SCHEMA IF NOT EXISTS platform_notifications;
CREATE SCHEMA IF NOT EXISTS platform_nurturing;
CREATE SCHEMA IF NOT EXISTS platform_templates;
```

- [ ] **Step 3: Create `docker/nginx-supabase.conf`**

The `@supabase/supabase-js` SDK routes auth requests to `{SUPABASE_URL}/auth/v1/*`.
GoTrue serves directly at `/*`. This nginx config translates the paths.

```nginx
server {
    listen 8000;
    server_name _;

    location /auth/v1/ {
        rewrite ^/auth/v1/(.*) /$1 break;
        proxy_pass http://supabase_auth:9999;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

- [ ] **Step 4: Commit**

```bash
git add docker/
git commit -m "chore: add Dockerfile.dev, init-db.sql, nginx-supabase.conf"
```

---

## Task 4: Create `.env.example` and Root `.gitignore`

**Files:**
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: Create `.gitignore` at repo root**

```gitignore
# Environment
.env

# Dependencies
node_modules/

# Build output
dist/

# OS
.DS_Store
```

- [ ] **Step 2: Create `.env.example`**

```bash
# ═══════════════════════════════════════════════════════════════════════════════
# Ortho CRM — Local Development Environment
# Copy to .env and fill in real values where marked PLACEHOLDER.
# Run ./scripts/dev/gen-keys.sh after copying to generate crypto keys.
# ═══════════════════════════════════════════════════════════════════════════════

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
GoTrue__Host=supabase_auth
GoTrue__Port=9999
GoTrue__JWT_Secret=super-secret-jwt-token-with-at-least-32-chars
GoTrue__Service_Role_Key=PLACEHOLDER    # generated by scripts/dev/gen-keys.sh

# ── GoTrue Proxy (nginx — rewrites /auth/v1/* → /*) ──────────────────────────
GoTrue__Proxy_Host=supabase_proxy
GoTrue__Proxy_Port=8000
GoTrue__Proxy_URL=http://${GoTrue__Proxy_Host}:${GoTrue__Proxy_Port}

# ── MailHog ───────────────────────────────────────────────────────────────────
MailHog__Host=mailhog
MailHog__SMTP_Port=1025

# ── Identity Service ──────────────────────────────────────────────────────────
Identity_Service__Host=identity
Identity_Service__Port=3100
Identity_Service__URL=http://${Identity_Service__Host}:${Identity_Service__Port}
Identity_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
Identity__Private_Key=PLACEHOLDER       # generated by scripts/dev/gen-keys.sh
Identity__JWKS_Keys=[]                  # generated by scripts/dev/gen-keys.sh
Identity__Internal_API_Secret=dev-internal-secret
Identity__CORS_Origin=http://localhost:3000

# ── AI Service ────────────────────────────────────────────────────────────────
Ai_Service__Host=ai
Ai_Service__Port=3101
Ai_Service__URL=http://${Ai_Service__Host}:${Ai_Service__Port}
Ai_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}

# ── Template Service ──────────────────────────────────────────────────────────
Template_Service__Host=template
Template_Service__Port=3102
Template_Service__URL=http://${Template_Service__Host}:${Template_Service__Port}
Template_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
Template_Service__JWT_Secret=dev-template-jwt-secret

# ── Notification Service ──────────────────────────────────────────────────────
Notification_Service__Host=notification
Notification_Service__Port=3103
Notification_Service__URL=http://${Notification_Service__Host}:${Notification_Service__Port}
Notification_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
Notification_Service__JWT_HMAC_Secret=dev-notification-jwt-secret

# ── Audience Engine ───────────────────────────────────────────────────────────
Audience_Service__Host=audience
Audience_Service__Port=3104
Audience_Service__URL=http://${Audience_Service__Host}:${Audience_Service__Port}
Audience_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}

# ── Analytics Service ─────────────────────────────────────────────────────────
Analytics_Service__Host=analytics
Analytics_Service__Port=3105
Analytics_Service__URL=http://${Analytics_Service__Host}:${Analytics_Service__Port}
Analytics_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
Analytics_Service__Admin_Recompute_Key=dev-recompute-key
Analytics_Service__Consumer_Group=analytics-service
Analytics_Service__SQS_Queue_URL=UNUSED-IN-DEV

# ── Messaging Service ─────────────────────────────────────────────────────────
Messaging_Service__Host=messaging
Messaging_Service__Port=3106
Messaging_Service__URL=http://${Messaging_Service__Host}:${Messaging_Service__Port}
Messaging_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
Messaging_Service__Consumer_Group=messaging-service
Messaging_Service__Status_Callback_URL=http://localhost:${Messaging_Service__Port}/webhooks/twilio/status
Twilio__Account_SID=AC_PLACEHOLDER
Twilio__Auth_Token=PLACEHOLDER

# ── Email Service ─────────────────────────────────────────────────────────────
Email_Service__Host=email
Email_Service__Port=3107
Email_Service__URL=http://${Email_Service__Host}:${Email_Service__Port}
Email_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
Email_Service__Consumer_Group=email-service
SendGrid__API_Key=SG.PLACEHOLDER
SendGrid__Webhook_Signing_Key_Secret_ARN=PLACEHOLDER

# ── Nurturing Engine ──────────────────────────────────────────────────────────
Nurturing_Service__Host=nurturing
Nurturing_Service__Port=3108
Nurturing_Service__URL=http://${Nurturing_Service__Host}:${Nurturing_Service__Port}
Nurturing_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
Nurturing_Service__Consumer_Group=nurturing-engine

# ── Automation Engine ─────────────────────────────────────────────────────────
Automation_Service__Host=automation
Automation_Service__Port=3109
Automation_Service__URL=http://${Automation_Service__Host}:${Automation_Service__Port}
Automation_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}

# ── Integration Hub ───────────────────────────────────────────────────────────
Integration_Hub__Host=integration_hub
Integration_Hub__Port=3110
Integration_Hub__URL=http://${Integration_Hub__Host}:${Integration_Hub__Port}
Integration_Hub__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
Integration_Hub__Consumer_Group=integration-hub
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

- [ ] **Step 3: Commit**

```bash
git add .env.example .gitignore
git commit -m "chore: add root .gitignore and .env.example for local dev"
```

---

## Task 5: Write `docker-compose.yml` — Infra Tier

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Write the infra tier (always-on services)**

Create `docker-compose.yml`:

```yaml
name: ortho

services:

  # ── Infrastructure ───────────────────────────────────────────────────────────

  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${Postgres__User}
      POSTGRES_PASSWORD: ${Postgres__Password}
      POSTGRES_DB: ${Postgres__DB}
    ports:
      - "${Postgres__Port}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./docker/init-db.sql:/docker-entrypoint-initdb.d/init-db.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${Postgres__User} -d ${Postgres__DB}"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports:
      - "${Redis__Port}:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  supabase_auth:
    image: supabase/gotrue:latest
    environment:
      GOTRUE_API_HOST: "0.0.0.0"
      GOTRUE_API_PORT: "9999"
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}?search_path=auth
      GOTRUE_SITE_URL: http://localhost:3000
      GOTRUE_JWT_SECRET: ${GoTrue__JWT_Secret}
      GOTRUE_JWT_EXP: "3600"
      GOTRUE_MAILER_AUTOCONFIRM: "true"
      GOTRUE_DISABLE_SIGNUP: "false"
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_SMTP_HOST: ${MailHog__Host}
      GOTRUE_SMTP_PORT: ${MailHog__SMTP_Port}
      GOTRUE_SMTP_ADMIN_EMAIL: admin@example.com
      GOTRUE_SMTP_MAX_FREQUENCY: 1s
    ports:
      - "${GoTrue__Port}:9999"
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:9999/health || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 10

  supabase_proxy:
    image: nginx:alpine
    volumes:
      - ./docker/nginx-supabase.conf:/etc/nginx/conf.d/default.conf:ro
    ports:
      - "${GoTrue__Proxy_Port}:8000"
    depends_on:
      supabase_auth:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:8000/auth/v1/health || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 10

  mailhog:
    image: mailhog/mailhog:latest
    ports:
      - "${MailHog__SMTP_Port}:1025"
      - "8025:8025"

volumes:
  postgres_data:
  redis_data:
```

- [ ] **Step 2: Validate compose syntax**

Run from the repo root (with `.env` present):

```bash
docker compose config
```

Expected: prints the fully resolved config with no errors.

- [ ] **Step 3: Smoke-test infra startup**

```bash
docker compose up -d
docker compose ps
```

Expected: `postgres`, `redis`, `supabase_auth`, `supabase_proxy`, `mailhog` all show `healthy` or `running`.

```bash
docker compose down
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: docker-compose infra tier (postgres, redis, gotrue, nginx proxy, mailhog)"
```

---

## Task 6: Write `docker-compose.yml` — Services Tier

**Files:**
- Modify: `docker-compose.yml` (append services)

Append the following `services:` entries to `docker-compose.yml`. Each service has a `_migrations` companion that runs once and exits before the main service starts. Both share the same image (built once).

- [ ] **Step 1: Append identity + identity_migrations**

```yaml
  # ── Platform Services (profile: services) ───────────────────────────────────

  identity_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/identity
    image: ortho-identity
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Identity_Service__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  identity:
    image: ortho-identity
    profiles: [services]
    ports:
      - "${Identity_Service__Port}:3100"
    environment:
      PORT: "3100"
      DATABASE_URL: ${Identity_Service__DB_URL}
      REDIS_URL: ${Redis__URL}
      AUTH_PROVIDER: supabase
      SUPABASE_URL: ${GoTrue__Proxy_URL}
      SUPABASE_SERVICE_ROLE_KEY: ${GoTrue__Service_Role_Key}
      IDENTITY_PRIVATE_KEY: ${Identity__Private_Key}
      IDENTITY_JWKS_KEYS: ${Identity__JWKS_Keys}
      INTERNAL_API_SECRET: ${Identity__Internal_API_Secret}
      CORS_ORIGIN: ${Identity__CORS_Origin}
      LOG_LEVEL: info
    depends_on:
      identity_migrations:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
      supabase_proxy:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3100/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 2: Append ai + ai_migrations**

```yaml
  ai_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/ai
    image: ortho-ai
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Ai_Service__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  ai:
    image: ortho-ai
    profiles: [services]
    ports:
      - "${Ai_Service__Port}:3101"
    environment:
      PORT: "3101"
      DATABASE_URL: ${Ai_Service__DB_URL}
      LOG_LEVEL: info
    depends_on:
      ai_migrations:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3101/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 3: Append template + template_migrations**

```yaml
  template_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/template
    image: ortho-template
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Template_Service__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  template:
    image: ortho-template
    profiles: [services]
    ports:
      - "${Template_Service__Port}:3102"
    environment:
      PORT: "3102"
      DATABASE_URL: ${Template_Service__DB_URL}
      JWT_SECRET: ${Template_Service__JWT_Secret}
    depends_on:
      template_migrations:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3102/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 4: Append notification + notification_migrations**

```yaml
  notification_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/notification
    image: ortho-notification
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Notification_Service__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  notification:
    image: ortho-notification
    profiles: [services]
    ports:
      - "${Notification_Service__Port}:3103"
    environment:
      PORT: "3103"
      DATABASE_URL: ${Notification_Service__DB_URL}
      REDIS_URL: ${Redis__URL}
      JWT_HMAC_SECRET: ${Notification_Service__JWT_HMAC_Secret}
    depends_on:
      notification_migrations:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
      identity:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3103/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 5: Append audience + audience_migrations**

```yaml
  audience_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/audience
    image: ortho-audience
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Audience_Service__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  audience:
    image: ortho-audience
    profiles: [services]
    ports:
      - "${Audience_Service__Port}:3104"
    environment:
      PORT: "3104"
      DATABASE_URL: ${Audience_Service__DB_URL}
      REDIS_URL: ${Redis__URL}
    depends_on:
      audience_migrations:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3104/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 6: Append analytics + analytics_migrations**

```yaml
  analytics_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/analytics
    image: ortho-analytics
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Analytics_Service__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  analytics:
    image: ortho-analytics
    profiles: [services]
    ports:
      - "${Analytics_Service__Port}:3105"
    environment:
      PORT: "3105"
      DATABASE_URL: ${Analytics_Service__DB_URL}
      REDIS_URL: ${Redis__URL}
      SQS_QUEUE_URL: ${Analytics_Service__SQS_Queue_URL}
      IDENTITY_SERVICE_URL: ${Identity_Service__URL}
      ADMIN_RECOMPUTE_KEY: ${Analytics_Service__Admin_Recompute_Key}
      EVENT_BUS_DRIVER: redis
      EVENT_BUS_CONSUMER_GROUP: ${Analytics_Service__Consumer_Group}
      LOG_LEVEL: info
    depends_on:
      analytics_migrations:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
      identity:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3105/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 7: Append messaging + messaging_migrations**

```yaml
  messaging_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/messaging
    image: ortho-messaging
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Messaging_Service__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  messaging:
    image: ortho-messaging
    profiles: [services]
    ports:
      - "${Messaging_Service__Port}:3106"
    environment:
      PORT: "3106"
      DATABASE_URL: ${Messaging_Service__DB_URL}
      REDIS_URL: ${Redis__URL}
      TWILIO_ACCOUNT_SID: ${Twilio__Account_SID}
      TWILIO_AUTH_TOKEN: ${Twilio__Auth_Token}
      TWILIO_STATUS_CALLBACK_URL: ${Messaging_Service__Status_Callback_URL}
      EVENT_BUS_DRIVER: redis
      EVENT_BUS_CONSUMER_GROUP: ${Messaging_Service__Consumer_Group}
    depends_on:
      messaging_migrations:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3106/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 8: Append email + email_migrations**

```yaml
  email_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/email
    image: ortho-email
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Email_Service__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  email:
    image: ortho-email
    profiles: [services]
    ports:
      - "${Email_Service__Port}:3107"
    environment:
      PORT: "3107"
      DATABASE_URL: ${Email_Service__DB_URL}
      REDIS_URL: ${Redis__URL}
      SENDGRID_API_KEY: ${SendGrid__API_Key}
      SENDGRID_WEBHOOK_SIGNING_KEY_SECRET_ARN: ${SendGrid__Webhook_Signing_Key_Secret_ARN}
      TEMPLATE_SERVICE_URL: ${Template_Service__URL}
      EVENT_BUS_DRIVER: redis
      EVENT_BUS_CONSUMER_GROUP: ${Email_Service__Consumer_Group}
    depends_on:
      email_migrations:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
      template:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3107/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 9: Append nurturing + nurturing_migrations**

```yaml
  nurturing_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/nurturing
    image: ortho-nurturing
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Nurturing_Service__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  nurturing:
    image: ortho-nurturing
    profiles: [services]
    ports:
      - "${Nurturing_Service__Port}:3108"
    environment:
      PORT: "3108"
      DATABASE_URL: ${Nurturing_Service__DB_URL}
      REDIS_URL: ${Redis__URL}
      TEMPLATE_SERVICE_URL: ${Template_Service__URL}
      MESSAGING_SERVICE_URL: ${Messaging_Service__URL}
      EMAIL_SERVICE_URL: ${Email_Service__URL}
      AI_SERVICE_URL: ${Ai_Service__URL}
      EVENT_BUS_DRIVER: redis
      EVENT_BUS_CONSUMER_GROUP: ${Nurturing_Service__Consumer_Group}
    depends_on:
      nurturing_migrations:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
      template:
        condition: service_healthy
      messaging:
        condition: service_healthy
      email:
        condition: service_healthy
      ai:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3108/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 10: Append automation + automation_migrations**

```yaml
  automation_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/automation
    image: ortho-automation
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Automation_Service__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  automation:
    image: ortho-automation
    profiles: [services]
    ports:
      - "${Automation_Service__Port}:3109"
    environment:
      PORT: "3109"
      DATABASE_URL: ${Automation_Service__DB_URL}
      REDIS_URL: ${Redis__URL}
      TEMPLATE_SERVICE_URL: ${Template_Service__URL}
      EMAIL_SERVICE_URL: ${Email_Service__URL}
      MESSAGING_SERVICE_URL: ${Messaging_Service__URL}
      AI_SERVICE_URL: ${Ai_Service__URL}
      NURTURING_ENGINE_URL: ${Nurturing_Service__URL}
      # SQS_QUEUE_URL intentionally omitted — automation won't receive events in
      # local dev (no SQS fallback in its consumer). Trigger rules via API manually.
    depends_on:
      automation_migrations:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
      template:
        condition: service_healthy
      messaging:
        condition: service_healthy
      email:
        condition: service_healthy
      ai:
        condition: service_healthy
      nurturing:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3109/healthz || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 11: Append integration_hub + integration_hub_migrations**

```yaml
  integration_hub_migrations:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
      args:
        SERVICE_PATH: apps/platform/integration-hub
    image: ortho-integration-hub
    command: npm run migrate
    profiles: [services]
    environment:
      DATABASE_URL: ${Integration_Hub__DB_URL}
    depends_on:
      postgres:
        condition: service_healthy

  integration_hub:
    image: ortho-integration-hub
    profiles: [services]
    ports:
      - "${Integration_Hub__Port}:3110"
    environment:
      PORT: "3110"
      NODE_ENV: development
      DATABASE_URL: ${Integration_Hub__DB_URL}
      REDIS_URL: ${Redis__URL}
      EVENT_BUS_DRIVER: redis
      EVENT_BUS_CONSUMER_GROUP: ${Integration_Hub__Consumer_Group}
      SECRETS_PROVIDER: env
      JWT_MODE: jwks
      IDENTITY_SERVICE_JWKS_URL: ${Identity_Service__URL}/identity/.well-known/jwks.json
      OAUTH_STATE_SECRET: ${Integration_Hub__OAuth_State_Secret}
      GOOGLE_ADS_CLIENT_ID: ${Google_Ads__Client_ID}
      GOOGLE_ADS_CLIENT_SECRET: ${Google_Ads__Client_Secret}
      GOOGLE_ADS_DEVELOPER_TOKEN: ${Google_Ads__Developer_Token}
      GOOGLE_ADS_REDIRECT_URI: ${Google_Ads__Redirect_URI}
      GOOGLE_ADS_WEBHOOK_VERIFY_TOKEN: ${Google_Ads__Webhook_Verify_Token}
      META_APP_ID: ${Meta__App_ID}
      META_APP_SECRET: ${Meta__App_Secret}
      META_REDIRECT_URI: ${Meta__Redirect_URI}
      META_WEBHOOK_VERIFY_TOKEN: ${Meta__Webhook_Verify_Token}
      LOG_LEVEL: info
    depends_on:
      integration_hub_migrations:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
      identity:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3110/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 12: Validate compose syntax**

```bash
docker compose config
```

Expected: full resolved YAML printed, no errors.

- [ ] **Step 13: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: docker-compose services tier (11 platform services + migration companions)"
```

---

## Task 7: Write Dev Scripts and Key Generator

**Files:**
- Create: `scripts/dev/gen-keys.ts`
- Create: `scripts/dev/gen-keys.sh`
- Create: `scripts/dev/up.sh`
- Create: `scripts/dev/up-all.sh`
- Create: `scripts/dev/down.sh`
- Create: `scripts/dev/logs.sh`
- Create: `scripts/dev/reset.sh`

- [ ] **Step 1: Create `scripts/dev/gen-keys.ts`**

Generates `Identity__Private_Key`, `Identity__JWKS_Keys`, and `GoTrue__Service_Role_Key` and writes them into the root `.env` file (merging, not overwriting other values).

```typescript
import { generateKeyPairSync, createPublicKey, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve to monorepo root .env (two levels up from scripts/dev/)
const envPath = resolve(__dirname, '../../.env');

// ── Identity RSA keypair ────────────────────────────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const jwk = createPublicKey(publicKey).export({ format: 'jwk' }) as Record<string, unknown>;
jwk.kid = 'dev-1';
jwk.use = 'sig';
jwk.alg = 'RS256';

// ── GoTrue service_role JWT ─────────────────────────────────────────────────
// Read the JWT secret from .env if it exists, otherwise use the default from .env.example
let gotrueSecret = 'super-secret-jwt-token-with-at-least-32-chars';
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  const line = lines.find((l) => l.startsWith('GoTrue__JWT_Secret='));
  if (line) gotrueSecret = line.split('=').slice(1).join('=');
}

const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(
  JSON.stringify({
    role: 'service_role',
    iss: 'supabase-demo',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600, // 10 years
  }),
).toString('base64url');
const sig = createHmac('sha256', gotrueSecret).update(`${header}.${payload}`).digest('base64url');
const serviceRoleKey = `${header}.${payload}.${sig}`;

// ── Merge into .env ─────────────────────────────────────────────────────────
const newVars: Record<string, string> = {
  'Identity__Private_Key': privateKey,
  'Identity__JWKS_Keys': JSON.stringify([jwk]),
  'GoTrue__Service_Role_Key': serviceRoleKey,
};

let existingLines: string[] = [];
if (existsSync(envPath)) {
  existingLines = readFileSync(envPath, 'utf-8').split('\n');
}

for (const [key, value] of Object.entries(newVars)) {
  const idx = existingLines.findIndex((line) => line.startsWith(`${key}=`));
  // Multiline values (PEM keys) are double-quote-wrapped with \n escaping
  const escaped = value.includes('\n') ? `"${value.replace(/\n/g, '\\n')}"` : value;
  const entry = `${key}=${escaped}`;
  if (idx >= 0) {
    existingLines[idx] = entry;
  } else {
    existingLines.push(entry);
  }
}

while (existingLines.length > 0 && existingLines[existingLines.length - 1] === '') {
  existingLines.pop();
}
existingLines.push('');

writeFileSync(envPath, existingLines.join('\n'));

console.log('Keys written to .env:');
console.log('  Identity__Private_Key: RSA-2048 PKCS#1 PEM');
console.log('  Identity__JWKS_Keys: JWK array with kid=dev-1');
console.log('  GoTrue__Service_Role_Key: HS256 JWT, 10-year expiry');
console.log(`  Path: ${envPath}`);
```

- [ ] **Step 2: Create `scripts/dev/gen-keys.sh`**

```bash
#!/bin/sh
set -e
# Resolve repo root regardless of where script is called from
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
echo "Generating dev crypto keys..."
cd "$REPO_ROOT"
npx tsx scripts/dev/gen-keys.ts
echo "Done."
```

Make executable: `chmod +x scripts/dev/gen-keys.sh`

- [ ] **Step 3: Create `scripts/dev/up.sh`**

```bash
#!/bin/sh
set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
docker compose up -d
echo "Infra running. Postgres: localhost:5432 | Redis: localhost:6379 | GoTrue: localhost:9999 | MailHog UI: http://localhost:8025"
```

Make executable: `chmod +x scripts/dev/up.sh`

- [ ] **Step 4: Create `scripts/dev/up-all.sh`**

```bash
#!/bin/sh
set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
docker compose --profile services up -d --build
echo "Full platform stack running. Services on ports 3100-3110."
```

Make executable: `chmod +x scripts/dev/up-all.sh`

- [ ] **Step 5: Create `scripts/dev/down.sh`**

```bash
#!/bin/sh
set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
docker compose --profile services down
```

Make executable: `chmod +x scripts/dev/down.sh`

- [ ] **Step 6: Create `scripts/dev/logs.sh`**

```bash
#!/bin/sh
# Usage: ./scripts/dev/logs.sh [service-name]
# Example: ./scripts/dev/logs.sh identity
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
docker compose --profile services logs -f "$@"
```

Make executable: `chmod +x scripts/dev/logs.sh`

- [ ] **Step 7: Create `scripts/dev/reset.sh`**

```bash
#!/bin/sh
set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
echo "Wiping all volumes and restarting infra (clean slate)..."
docker compose --profile services down -v
docker compose up -d
echo "Clean infra running. Run gen-keys.sh and seed-super-admin if needed."
```

Make executable: `chmod +x scripts/dev/reset.sh`

- [ ] **Step 8: Commit**

```bash
git add scripts/dev/
git commit -m "feat: dev scripts (up, up-all, down, logs, reset, gen-keys)"
```

---

## Task 8: Write Documentation + Smoke Test

**Files:**
- Create: `docs/development/local-dev.md`

- [ ] **Step 1: Create `docs/development/local-dev.md`**

```markdown
# Local Development Setup

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin) — v2.20+
- Node.js 24
- A terminal at the monorepo root

## First-Time Setup

### 1. Copy the environment template

\`\`\`bash
cp .env.example .env
\`\`\`

### 2. Generate crypto keys

\`\`\`bash
./scripts/dev/gen-keys.sh
\`\`\`

This writes three values into `.env`:
- `Identity__Private_Key` — RSA-2048 private key (signs JWTs issued by the Identity Service)
- `Identity__JWKS_Keys` — matching public key in JWK format (used by other services to verify JWTs)
- `GoTrue__Service_Role_Key` — HS256 JWT for Supabase admin SDK calls

### 3. Fill in real API keys (optional)

Open `.env` and replace `PLACEHOLDER` values for the services you intend to exercise:
- **Twilio** (`Twilio__Account_SID`, `Twilio__Auth_Token`) — for SMS sends
- **SendGrid** (`SendGrid__API_Key`) — for email sends
- **Google Ads / Meta** — for ad integration testing

Services with `PLACEHOLDER` values will start successfully but fail when they attempt real API calls.

### 4. Start infra

\`\`\`bash
./scripts/dev/up.sh
\`\`\`

| Service | URL |
|---------|-----|
| Postgres | `localhost:5432` |
| Redis | `localhost:6379` |
| GoTrue (Supabase Auth) | `http://localhost:9999` |
| MailHog (email UI) | `http://localhost:8025` |

### 5. Develop a single service

Run the service you're working on locally (hot reload):

\`\`\`bash
cd apps/platform/identity
npm install
npm run migrate   # run once on first setup or after pulling new migrations
npm run dev
\`\`\`

The service connects to compose infra on `localhost` ports. No other services need to be running.

### 6. Seed the super admin (once)

After the Identity Service starts for the first time:

\`\`\`bash
cd apps/platform/identity
DATABASE_URL="postgresql://ortho:changeme@localhost:5432/ortho" \
  npx tsx scripts/seed-super-admin.ts
\`\`\`

---

## Running the Full Platform Stack

Builds all 11 services and starts everything:

\`\`\`bash
./scripts/dev/up-all.sh
\`\`\`

Service ports:

| Service | Port |
|---------|------|
| Identity | 3100 |
| AI | 3101 |
| Template | 3102 |
| Notification | 3103 |
| Audience | 3104 |
| Analytics | 3105 |
| Messaging | 3106 |
| Email | 3107 |
| Nurturing | 3108 |
| Automation | 3109 |
| Integration Hub | 3110 |

**Note:** Automation won't receive domain events in local dev (its SQS consumer has no Redis fallback). Trigger automation rules manually via `POST /rules/:id/dry-run` or by direct API calls.

---

## Common Commands

\`\`\`bash
./scripts/dev/down.sh             # stop everything
./scripts/dev/logs.sh identity    # tail logs for one service
./scripts/dev/reset.sh            # wipe volumes + restart (clean slate)
docker compose ps                 # check container status
\`\`\`

---

## Troubleshooting

**`identity` service crashes with `Missing required env: IDENTITY_PRIVATE_KEY`**
Run `./scripts/dev/gen-keys.sh` — the crypto keys weren't generated yet.

**GoTrue healthcheck fails**
GoTrue runs its own DB migrations on startup. If postgres isn't fully ready, GoTrue may crash-loop for a few seconds then recover. Wait 30 seconds and check `docker compose ps`.

**Migration service exits non-zero**
Run `docker compose logs identity_migrations` to see the Knex error. Common cause: schema doesn't exist (check that `docker/init-db.sql` ran on the postgres container — it only runs on first start; if the `postgres_data` volume pre-exists, it won't re-run).

**Fresh start after a schema change**
\`\`\`bash
./scripts/dev/reset.sh   # wipes postgres_data volume, re-runs init-db.sql
\`\`\`
```

- [ ] **Step 2: Update NAVIGATOR.md to add local-dev.md**

In `docs/NAVIGATOR.md`, add a new section:

```markdown
## Development Guides (`docs/development/`)

| Guide | Description |
|-------|-------------|
| [local-dev.md](development/local-dev.md) | Local development setup with docker-compose |
```

- [ ] **Step 3: Full infra smoke test**

With `.env` populated (gen-keys.sh run):

```bash
docker compose up -d
```

Expected: all 5 infra containers reach healthy state within 60 seconds.

```bash
docker compose ps
```

Expected output (all healthy):
```
NAME              STATUS
ortho-postgres-1         healthy
ortho-redis-1            healthy
ortho-supabase_auth-1    healthy
ortho-supabase_proxy-1   healthy
ortho-mailhog-1          running
```

- [ ] **Step 4: Full services smoke test**

```bash
docker compose --profile services up -d --build
```

Wait 2-3 minutes for all builds and migrations. Then:

```bash
docker compose --profile services ps
```

Expected: all 11 services show `healthy`. Migration companions show `exited (0)`.

Spot-check health endpoints:

```bash
curl -s http://localhost:3100/health | grep ok
curl -s http://localhost:3101/health | grep ok
curl -s http://localhost:3109/healthz | grep ok
```

Expected: each returns `{"ok":true}` or similar.

- [ ] **Step 5: Tear down**

```bash
docker compose --profile services down
```

- [ ] **Step 6: Commit**

```bash
git add docs/development/local-dev.md docs/NAVIGATOR.md
git commit -m "docs: local dev setup guide"
```

---

## Self-Review Notes

- **Spec correction:** The design spec had `Integration_Hub__DB_Name=platform_integration`. The actual knexfile uses `platform_integrations` (with 's'). The plan uses `platform_integrations` throughout (init-db.sql, env notes). The `.env.example` doesn't include the `__DB_Name` vars — only the composed `__DB_URL`.

- **Automation events:** The spec says "automation won't receive events in local dev" — documented in the local-dev.md troubleshooting section and in the compose comment on `SQS_QUEUE_URL`.

- **GoTrue proxy:** Not in the original design spec (discovered during planning). Added `supabase_proxy` nginx container to the infra tier to handle the `/auth/v1/` path prefix that `@supabase/supabase-js` SDK requires.

- **Migration files are TypeScript:** The migrate script uses `npx tsx` rather than just `knex` CLI directly, because migration files are `.ts` and Node cannot execute them natively.
