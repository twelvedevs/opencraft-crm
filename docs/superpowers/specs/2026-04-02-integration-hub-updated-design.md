# Integration Hub — Updated Design Spec (v2)

**Date:** 2026-04-02
**Status:** Approved
**Supersedes:** `docs/superpowers/specs/2026-03-25-integration-hub-design.md`
**Scope:** Backend service only — `apps/platform/integration-hub`. UI package (`@platform/integration-hub-ui`) is deferred to a separate deliverable.

---

## What Changed from v1

This document incorporates all clarifications from `tasks/prd-questions-integration-hub.md`. The sections below are self-contained; read this document alone.

Key amendments from the Q&A:

| Topic | Decision |
|---|---|
| OAuth PKCE state | Stateless — encoded and HMAC-signed in the `state` parameter; no server-side storage |
| Token encryption format | AES-256-GCM; store `{ iv, ciphertext, tag }` as base64-encoded JSON per column |
| Secrets Manager abstraction | `SecretsProvider` interface with `AwsSecretsProvider` (prod) and `EnvSecretsProvider` (local dev) |
| JWT validation | Configurable: static public key **or** JWKS endpoint, selected by env var |
| Google Ads API client | `google-ads-api` npm package wrapped in typed `GoogleAdsClient` helper |
| Meta API client | Native `fetch` wrapped in typed `MetaApiClient` helper |
| API version constants | Both connectors declare their API version in a module-level constant |
| EventBus startup | Publish-only — `createEventBus()` + `bus.publish()`; `bus.start()` never called |
| `@ortho/types` additions | `AdLeadReceivedEvent` and `AdSpendSyncedEvent` added to `packages/@ortho/types` |
| Poll job startup reconciliation | Load all `active` accounts on startup; `upsertJobScheduler` for each (idempotent) |
| `refresh-token` job removal | `queue.getJob('refresh-token:{account_id}')` then `job?.remove()` |
| Malformed webhook body | Persisted to `failed_webhooks` DB table in addition to warn log |
| Webhook verify endpoint | Generic `GET /integrations/webhooks/:platform/verify` (handles both Meta and Google Ads) |
| Backfill progress | Dedicated `backfill_jobs` DB table — progress written after each chunk |
| Datadog alerts | Structured `log.error(...)` fields only; log-based monitor configured in Datadog |
| DB query pattern | Knex 3 for migrations only; raw `pg` Pool + `PoolClient` for runtime queries |
| Test scope | Unit tests only for this pass |

---

## 1. Overview

The Integration Hub is a **platform-layer service** (`apps/platform/integration-hub`) that connects external advertising platforms to the Ortho CRM analytics and lead-capture pipelines. It is fully domain-agnostic.

**Core responsibilities:**
- OAuth credential management: authorize external ad accounts, store encrypted tokens, refresh before expiry
- Webhook ingestion: receive real-time lead events from Meta Lead Ads and Google Ads lead forms, verify signatures, publish to EventBridge
- Ad spend polling: pull campaign-level spend, impression, and click data every 4 hours via BullMQ repeatable jobs
- Historical backfill: manually triggered date-range import of historical spend data

**Initial adapters:** Google Ads API, Meta Marketing API

**Events published:**
- `ad_lead.received` → consumed by Lead Service
- `ad_spend.synced` → consumed by Analytics Service

**Out of scope (this pass):**
- `@platform/integration-hub-ui` React component package — separate deliverable
- Ortho-specific metric computation — owned by Reporting Service
- Lead deduplication and CRM record creation — owned by Lead Service

---

## 2. Architecture

```
Meta / Google Ads
      │
      ├─── Webhook push ──► POST /integrations/webhooks/:platform
      │                          │ verifyWebhook() [sync, in route handler]
      │                          │ parseLeadWebhook() [sync, pure]
      │                          │   └── on parse error: persist to failed_webhooks; return 200
      │                          └──► BullMQ: process-lead-webhook (one job per LeadEvent)
      │                                    │ resolve location_id from mappings
      │                                    └──► EventBus.publish: ad_lead.received
      │
      ├─── Verify challenge ──► GET /integrations/webhooks/:platform/verify
      │                              │ verify hub.verify_token or shared secret
      │                              └── return hub.challenge (200) or 403
      │
      └─── Polling (every 4h) ◄── BullMQ repeatable job per account
                                        │ fetchSpend()
                                        └──► EventBus.publish: ad_spend.synced
```

### 2.1 EventBus Usage

Integration Hub is **publish-only** — it publishes events but never subscribes. Per `adr-event-bus.md`:

```ts
import { createEventBus } from '@ortho/event-bus';

const bus = createEventBus(); // reads EVENT_BUS_DRIVER from env
// bus.start() is NOT called — no subscriptions, no consumer loop
```

The `bus` instance is created once at service startup and passed to job handlers. `bus.publish()` is called from within `process-lead-webhook` and `poll-ad-spend` job workers.

### 2.2 Connector Interface

Each platform adapter implements this TypeScript interface. Adding a new connector requires implementing the interface and registering it in the `ConnectorRegistry`.

```typescript
interface Connector {
  platform: string

  // OAuth
  getAuthorizationUrl(codeChallenge: string, state: string): string
  exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens>
  refreshTokens(account: IntegrationAccount): Promise<OAuthTokens>

  // Polling
  fetchSpend(account: IntegrationAccount, date: string): Promise<SpendRecord[]>
  fetchSpendRange(account: IntegrationAccount, from: string, to: string): Promise<SpendRecord[]>

  // Webhooks
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): boolean
  parseLeadWebhook(payload: unknown): LeadEvent[]
  verifyChallenge(query: Record<string, string>): string | null  // returns challenge token or null if invalid
}
```

`ConnectorRegistry` is a `Map<string, Connector>` populated at startup. Routes dispatch to the connector for the requested `:platform` — unknown platforms return `400`.

### 2.3 Supported Connectors

**Google Ads (`google_ads`):**
- OAuth 2.0 with offline access (refresh token). Token refresh via `refresh-token` BullMQ job 30 minutes before expiry.
- API client: `google-ads-api` npm package, wrapped in `GoogleAdsClient` typed helper (see §11).
- Spend data: GAQL campaign performance report — `metrics.cost_micros`, `metrics.impressions`, `metrics.clicks` per campaign per day.
- Lead forms: webhook push to `POST /integrations/webhooks/google_ads`. Signature verification via shared secret configured in Google Ads lead form settings.
- Webhook challenge: `GET /integrations/webhooks/google_ads/verify` — `connector.verifyChallenge(query)` checks `hub.verify_token` against `GOOGLE_ADS_WEBHOOK_VERIFY_TOKEN` env var; returns `hub.challenge`.

**Meta (`facebook_ads`):**
- OAuth 2.0 with long-lived user access token (60-day expiry). No `refresh-token` job — when a poll fails with an auth error, `status` is set to `'error'`; recovery requires manual reconnect.
- API client: native `fetch` wrapped in `MetaApiClient` typed helper (see §11).
- Spend data: Marketing API `/act_{account_id}/insights` — `spend`, `impressions`, `clicks`, `campaign_id`, `campaign_name` per day.
- Lead Ads: webhook push to `POST /integrations/webhooks/facebook_ads`. Signature verification via `X-Hub-Signature-256` (HMAC-SHA256 of raw body using app secret).
- Webhook challenge: `GET /integrations/webhooks/:platform/verify` — `connector.verifyChallenge(query)` checks `hub.verify_token` against `META_WEBHOOK_VERIFY_TOKEN` env var; returns `hub.challenge`.

---

## 3. Data Model

Schema: `platform_integrations`
Runtime DB access: raw `pg` Pool + `PoolClient`. Knex 3 is used for migrations only.

### 3.1 `integration_accounts`

One row per connected ad account.

```sql
id               uuid         PRIMARY KEY DEFAULT gen_random_uuid()
platform         text         NOT NULL                    -- 'google_ads' | 'facebook_ads'
account_id       text         NOT NULL                    -- platform-native account ID
account_name     text                                     -- cached for display
access_token     text         NOT NULL                    -- AES-256-GCM encrypted (see §8)
refresh_token    text                                     -- AES-256-GCM encrypted; null for Meta
token_expires_at timestamptz
status           text         NOT NULL DEFAULT 'active'   -- 'active' | 'paused' | 'error'
last_error       text
last_polled_at   timestamptz
created_at       timestamptz  NOT NULL DEFAULT now()

UNIQUE (platform, account_id)
```

### 3.2 `campaign_location_mappings`

Maps platform campaigns to location IDs. Location IDs are opaque strings to this service.

```sql
id            uuid  PRIMARY KEY DEFAULT gen_random_uuid()
account_id    uuid  NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE
campaign_id   text  NOT NULL    -- platform-native campaign ID
campaign_name text              -- cached; overwritten each poll cycle
location_id   text  NOT NULL    -- opaque; provided by the CRM shell

UNIQUE (account_id, campaign_id)
```

Campaigns with no mapping entry are polled but their data is **not published** in `ad_spend.synced`.

### 3.3 `failed_webhooks`

Persists raw bodies of webhook payloads that failed `parseLeadWebhook()` for manual inspection and replay.

```sql
id          uuid         PRIMARY KEY DEFAULT gen_random_uuid()
platform    text         NOT NULL
raw_body    text         NOT NULL
error       text         NOT NULL    -- stringified parse error
received_at timestamptz  NOT NULL DEFAULT now()
```

### 3.4 `backfill_jobs`

Tracks backfill progress per job. Written by the `backfill-ad-spend` worker after each chunk.

```sql
id           uuid         PRIMARY KEY DEFAULT gen_random_uuid()
account_id   uuid         NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE
status       text         NOT NULL DEFAULT 'active'  -- 'active' | 'completed' | 'failed'
from_date    date         NOT NULL
to_date      date         NOT NULL
chunks_done  integer      NOT NULL DEFAULT 0
chunks_total integer      NOT NULL
error        text
created_at   timestamptz  NOT NULL DEFAULT now()
updated_at   timestamptz  NOT NULL DEFAULT now()
```

The `GET /integrations/accounts/:id/backfill/:job_id` endpoint reads directly from this table.

---

## 4. API

All endpoints except webhooks require a valid Identity Service JWT (see §9).

### 4.1 OAuth Flow

| Method | Path | Description |
|---|---|---|
| `GET` | `/integrations/connect/:platform` | Build OAuth authorization URL with stateless PKCE state (see §10); redirect browser to platform |
| `GET` | `/integrations/oauth/:platform/callback` | Verify state, extract code_verifier; exchange authorization code for tokens; store encrypted; register BullMQ poll job; redirect to UI |
| `DELETE` | `/integrations/accounts/:id` | Disconnect account; remove BullMQ poll and refresh-token jobs; cascade-delete mappings |

### 4.2 Account Management

| Method | Path | Description |
|---|---|---|
| `GET` | `/integrations/accounts` | List all connected accounts with `status`, `last_polled_at`, `last_error` |
| `GET` | `/integrations/accounts/:id/campaigns` | Fetch current campaign list from platform API (live call); returns campaigns with existing mapping if any |
| `PUT` | `/integrations/accounts/:id/mappings` | Replace all campaign-to-location mappings for this account. Body: `{ mappings: [{ campaign_id, location_id }] }` |

### 4.3 Backfill

| Method | Path | Description |
|---|---|---|
| `POST` | `/integrations/accounts/:id/backfill` | Insert a row in `backfill_jobs`; enqueue `backfill-ad-spend` BullMQ job. Body: `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD" }`. Max range: 24 months. Returns `{ job_id }` (the `backfill_jobs.id` UUID). |
| `GET` | `/integrations/accounts/:id/backfill/:job_id` | Read from `backfill_jobs` table. Returns `{ job_id, status, progress: { chunks_done, chunks_total }, error? }`. |

### 4.4 Webhooks (no JWT — signature-verified)

| Method | Path | Description |
|---|---|---|
| `POST` | `/integrations/webhooks/:platform` | Receive webhook push from Google or Meta. Verify signature synchronously; return `200` immediately; enqueue `process-lead-webhook` BullMQ job per `LeadEvent`. On parse error, persist to `failed_webhooks` and still return `200`. |
| `GET` | `/integrations/webhooks/:platform/verify` | Webhook subscription verification for both Meta and Google Ads. Dispatches to `connector.verifyChallenge(query)`; returns the challenge string (200) or 403. |

Signature verification: invalid signature → `403`, no job enqueued, nothing written to `failed_webhooks`.
Parse error (valid signature but malformed body): write to `failed_webhooks`, log at `warn`, return `200`.

---

## 5. BullMQ Jobs

Four job types. One BullMQ `Queue` per job type (named `integration-hub:{type}`). Workers registered at service startup.

### 5.1 `poll-ad-spend`

**Schedule:** Repeatable, per account, every 4 hours. Key: `poll-ad-spend:{account_id}`.

**Startup reconciliation:** On service startup, load all accounts where `status != 'error'` from `integration_accounts`. For each, call:
```ts
await pollQueue.upsertJobScheduler(
  `poll-ad-spend:${account.id}`,
  { every: 4 * 60 * 60 * 1000 },
  { data: { account_id: account.id } }
)
```
This is idempotent — safe to call on every restart, handles Redis state loss.

**Execution:**
1. Load account + decrypt tokens from `integration_accounts`
2. Call `connector.fetchSpend(account, today)` and `connector.fetchSpend(account, yesterday)` (yesterday captures delayed platform reporting)
3. Look up `campaign_location_mappings` for this account
4. Drop unmapped campaigns (no mapping entry); group by `location_id`
5. Publish one `ad_spend.synced` event per `(platform, location_id, date)` via `bus.publish()`
6. Update `last_polled_at = now()`, `status = 'active'`, `last_error = null`

**On failure:** Set `status = 'error'`, write error message to `last_error`. Log: `log.error({ account_id, platform, err }, 'poll-ad-spend failed')`.

### 5.2 `refresh-token`

**Type:** Delayed one-off. Job ID: `refresh-token:{account_id}`. Delay: `ms until token_expires_at - 30 minutes`. Not registered for Meta accounts.

**Execution:** Call `connector.refreshTokens(account)` → write new encrypted `access_token`, `refresh_token`, `token_expires_at` → enqueue the next delayed `refresh-token` job. On failure: set `status = 'error'`, log `log.error({ account_id, platform, err }, 'refresh-token failed')`.

**On account disconnect:**
```ts
const job = await refreshQueue.getJob(`refresh-token:${account_id}`)
await job?.remove()
```

### 5.3 `process-lead-webhook`

**Type:** One-off per lead. Job ID: `{platform}:{external_lead_id}` (BullMQ silently rejects duplicates — deduplication for retried webhook deliveries).

**Execution:**
1. Receive `LeadEvent` (parsed by route handler before enqueue)
2. Look up `location_id` from `campaign_location_mappings` (null if unmapped)
3. Publish `ad_lead.received` via `bus.publish()`

### 5.4 `backfill-ad-spend`

**Type:** One-off. Created by `POST /integrations/accounts/:id/backfill`. The `backfill_jobs` row (with `job_id`) is inserted by the route handler before enqueuing; the job receives the `backfill_job_id` as its data payload.

**Execution:** Divide date range into 7-day chunks. For each chunk:
1. Call `connector.fetchSpendRange(account, chunkFrom, chunkTo)`
2. Group by `location_id`, drop unmapped campaigns
3. Publish one `ad_spend.synced` event per `(location_id, date)` via `bus.publish()`
4. Update `backfill_jobs` row: `chunks_done += 1`, `updated_at = now()`

On complete: update `status = 'completed'`.
On error: update `status = 'failed'`, `error = message`.

---

## 6. Event Payloads

### 6.1 `ad_spend.synced`

One event per `(platform, location_id, date)`. Re-syncs are idempotent (Analytics Service upserts on receipt).

```json
{
  "event_type": "ad_spend.synced",
  "payload": {
    "platform": "google_ads",
    "location_id": "loc_42",
    "synced_date": "2026-03-25",
    "records": [
      {
        "campaign_id": "123456",
        "campaign_name": "Spring Promo — Braces",
        "spend": 142.50,
        "impressions": 5000,
        "clicks": 230
      }
    ]
  }
}
```

### 6.2 `ad_lead.received`

`ad_set_id`, `ad_id`, and `form_id` are Meta-specific; absent for Google Ads. `location_id` is `null` when no mapping exists.

```json
{
  "event_type": "ad_lead.received",
  "payload": {
    "platform": "facebook_ads",
    "external_lead_id": "fb_lead_789012",
    "campaign_id": "456",
    "ad_set_id": "789",
    "ad_id": "012",
    "form_id": "345",
    "location_id": "loc_12",
    "fields": {
      "full_name": "Jane Smith",
      "phone_number": "+15551234567",
      "email": "jane@example.com"
    }
  }
}
```

---

## 7. `@ortho/types` Additions

As part of this implementation, add the following to `packages/@ortho/types/src/events.ts` so Lead Service and Analytics Service can import shared types:

```ts
// ad_lead.received
export interface AdLeadReceivedPayload {
  platform: string
  external_lead_id: string
  campaign_id: string
  ad_set_id?: string   // Meta only
  ad_id?: string       // Meta only
  form_id?: string     // Meta only
  location_id: string | null
  fields: Record<string, string>
}

export interface AdLeadReceivedEvent {
  event_type: 'ad_lead.received'
  payload: AdLeadReceivedPayload
}

// ad_spend.synced
export interface AdSpendRecord {
  campaign_id: string
  campaign_name: string
  spend: number
  impressions: number
  clicks: number
}

export interface AdSpendSyncedPayload {
  platform: string
  location_id: string
  synced_date: string   // YYYY-MM-DD
  records: AdSpendRecord[]
}

export interface AdSpendSyncedEvent {
  event_type: 'ad_spend.synced'
  payload: AdSpendSyncedPayload
}
```

---

## 8. Credential Security

### Encryption Format

`access_token` and `refresh_token` are encrypted with **AES-256-GCM**. Each field is stored as a base64-encoded JSON string of the form:

```json
{ "iv": "<hex>", "ciphertext": "<hex>", "tag": "<hex>" }
```

A fresh random 12-byte IV is generated for every encryption operation. The auth tag is 16 bytes.

The `credential-store.ts` module exposes two pure functions:

```ts
encrypt(plaintext: string, key: Buffer): string   // → base64(JSON)
decrypt(stored: string, key: Buffer): string       // → plaintext
```

### SecretsProvider Abstraction

The encryption key (and any future secrets) are accessed through a `SecretsProvider` interface, enabling local development without AWS:

```ts
interface SecretsProvider {
  getSecret(name: string): Promise<string>
}
```

Two implementations:

| Implementation | Class | When used |
|---|---|---|
| `AwsSecretsProvider` | Calls `GetSecretValue` via `@aws-sdk/client-secrets-manager` | `SECRETS_PROVIDER=aws` |
| `EnvSecretsProvider` | Returns `process.env[name]` | `SECRETS_PROVIDER=env` |

Selected at startup:
```ts
const secrets = createSecretsProvider() // reads SECRETS_PROVIDER env var
const rawKey = await secrets.getSecret('INTEGRATION_HUB_ENCRYPTION_KEY')
const encryptionKey = Buffer.from(rawKey, 'base64') // 32 bytes
```

The `INTEGRATION_HUB_ENCRYPTION_KEY` value is a base64-encoded 32-byte random value (44 characters).

Raw tokens are never written to logs and never returned in API responses.

---

## 9. JWT Validation

`@ortho/auth-middleware` is an empty stub. JWT validation is implemented as a Fastify `preHandler` plugin within this service, registered on all non-webhook routes.

**Mode** is selected via `JWT_MODE` env var:

| Mode | Env var | Behaviour |
|---|---|---|
| `static` | `IDENTITY_SERVICE_PUBLIC_KEY` (PEM string) | Verifies RS256 signature locally using the provided public key |
| `jwks` | `IDENTITY_SERVICE_JWKS_URL` | Fetches the JWKS endpoint and verifies the token using the matching key ID |

Both modes validate expiry, issuer (if `JWT_ISSUER` is set), and audience (if `JWT_AUDIENCE` is set). An invalid or expired token returns `401`.

Implementation lives in `src/plugins/jwt-auth.ts` as a Fastify plugin:
```ts
// src/plugins/jwt-auth.ts
export const jwtAuthPlugin = fp(async (fastify) => {
  fastify.addHook('preHandler', verifyJwt)
})
```

---

## 10. OAuth PKCE State (Stateless)

The OAuth `state` parameter carries the PKCE `code_verifier` and is verified on callback without any server-side session storage.

**On `GET /integrations/connect/:platform`:**
1. Generate a random `code_verifier` (43 bytes, base64url-encoded → 58 chars)
2. Compute `code_challenge = base64url(sha256(code_verifier))`
3. Build `statePayload = base64url(JSON.stringify({ cv: code_verifier, ts: Date.now() }))`
4. Compute `sig = HMAC-SHA256(statePayload, OAUTH_STATE_SECRET)`
5. Pass `state = statePayload + '.' + sig` to the OAuth provider alongside `code_challenge`

**On `GET /integrations/oauth/:platform/callback`:**
1. Split `state` on `.` → `[payload, sig]`
2. Recompute `HMAC-SHA256(payload, OAUTH_STATE_SECRET)` and compare with `sig` (constant-time)
3. Reject with `400` if invalid or if `ts` is older than 10 minutes
4. Decode `payload` to extract `code_verifier`
5. Call `connector.exchangeCode(code, code_verifier)` to get tokens

`OAUTH_STATE_SECRET` is a random string stored in env (or via SecretsProvider for production).

---

## 11. External API Clients

Each connector wraps its underlying HTTP/SDK calls in a typed client class. Connectors never call fetch or SDK methods directly — they delegate to these clients.

### `GoogleAdsClient`

Wraps the `google-ads-api` npm package. Handles auth header injection and response parsing.

```ts
class GoogleAdsClient {
  constructor(private readonly accessToken: string, private readonly customerId: string) {}

  async searchCampaignPerformance(date: string): Promise<CampaignPerformanceRow[]>
  async searchCampaignPerformanceRange(from: string, to: string): Promise<CampaignPerformanceRow[]>
}
```

API version is declared as a module-level constant and updated when upgrading:
```ts
const GOOGLE_ADS_API_VERSION = 'v19' // update when upgrading
```

### `MetaApiClient`

Wraps native `fetch`. Handles base URL construction, auth, and error parsing.

```ts
class MetaApiClient {
  constructor(private readonly accessToken: string, private readonly accountId: string) {}

  async getInsights(date: string): Promise<MetaInsightRow[]>
  async getInsightsRange(from: string, to: string): Promise<MetaInsightRow[]>
}
```

API version constant:
```ts
const META_GRAPH_API_VERSION = 'v22.0' // update when upgrading
```

---

## 12. Cross-Service Dependencies

| Dependency | Type | Notes |
|---|---|---|
| Analytics Service | EventBridge consumer (`ad_spend.synced`) | Payload: `platform`, `location_id`, `synced_date` + `records[]`. One event per `(platform, location_id, date)`. Unmapped campaigns not published. Types: `AdSpendSyncedEvent` from `@ortho/types`. |
| Lead Service | EventBridge consumer (`ad_lead.received`) | Must handle `location_id: null` gracefully. Types: `AdLeadReceivedEvent` from `@ortho/types`. |
| Identity Service | JWT validation | `JWT_MODE=static`: public key via env. `JWT_MODE=jwks`: JWKS endpoint URL via env. |
| AWS Secrets Manager | Startup secret load | `SECRETS_PROVIDER=aws` in production; `SECRETS_PROVIDER=env` for local dev. |
| `@ortho/event-bus` | Event publishing | `createEventBus()` — publish-only, `bus.start()` not called. |
| `@ortho/logger` | Structured logging | `createLogger('integration-hub')`. Child loggers per request via `log.child({ requestId })`. |
| `@ortho/types` | Shared event type contracts | `AdLeadReceivedEvent`, `AdSpendSyncedEvent` added in this implementation. |

---

## 13. Package Dependencies

```json
{
  "dependencies": {
    "@aws-sdk/client-secrets-manager": "^3.0.0",
    "@fastify/sensible": "^6.0.0",
    "@fastify/rate-limit": "^9.0.0",
    "@ortho/event-bus": "file:../../../packages/@ortho/event-bus",
    "@ortho/logger": "file:../../../packages/@ortho/logger",
    "@ortho/types": "file:../../../packages/@ortho/types",
    "@sinclair/typebox": "^0.34.0",
    "bullmq": "^5.0.0",
    "fastify": "^5.0.0",
    "google-ads-api": "^16.0.0",
    "ioredis": "^5.0.0",
    "knex": "^3.0.0",
    "pg": "^8.0.0",
    "fast-jwt": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

Notes:
- `google-ads-api` for Google connector; native `fetch` (Node 24 built-in) for Meta
- `fast-jwt` for `JWT_MODE=static` (RS256 local verification)
- For `JWT_MODE=jwks`, use `fast-jwt` with `createRemoteJWKSet` or `jwks-rsa` — confirm library at implementation time

---

## 14. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `production` \| `development` \| `test` |
| `PORT` | No | HTTP port (default `3000`) |
| `DATABASE_URL` | Yes | Postgres connection string |
| `REDIS_URL` | Yes | Redis connection URL for BullMQ |
| `EVENT_BUS_DRIVER` | Yes | `eventbridge` (prod) \| `redis` (local) |
| `EVENT_BRIDGE_BUS_NAME` | Prod | EventBridge bus name |
| `SQS_QUEUE_URL` | Prod | SQS FIFO queue URL |
| `EVENT_BUS_CONSUMER_GROUP` | `EVENT_BUS_DRIVER=redis` | Consumer group name — required by `RedisStreamsDriver` constructor even for publish-only services (e.g. `integration-hub`) |
| `SECRETS_PROVIDER` | Yes | `aws` \| `env` |
| `INTEGRATION_HUB_ENCRYPTION_KEY` | `env` mode | Base64-encoded 32-byte AES key (used when `SECRETS_PROVIDER=env`) |
| `JWT_MODE` | Yes | `static` \| `jwks` |
| `IDENTITY_SERVICE_PUBLIC_KEY` | `static` | PEM-encoded RS256 public key |
| `IDENTITY_SERVICE_JWKS_URL` | `jwks` | JWKS endpoint URL |
| `JWT_ISSUER` | No | Expected `iss` claim (optional validation) |
| `JWT_AUDIENCE` | No | Expected `aud` claim (optional validation) |
| `OAUTH_STATE_SECRET` | Yes | HMAC secret for stateless PKCE state signing (min 32 chars) |
| `GOOGLE_ADS_CLIENT_ID` | Yes | OAuth 2.0 client ID |
| `GOOGLE_ADS_CLIENT_SECRET` | Yes | OAuth 2.0 client secret |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Yes | Google Ads developer token |
| `GOOGLE_ADS_WEBHOOK_VERIFY_TOKEN` | Yes | Shared secret for lead form webhook challenge |
| `META_APP_ID` | Yes | Meta app ID |
| `META_APP_SECRET` | Yes | Meta app secret (used for HMAC-SHA256 webhook signature verification) |
| `META_WEBHOOK_VERIFY_TOKEN` | Yes | Meta webhook subscription verify token |
| `LOG_LEVEL` | No | Pino log level (default `info`) |

---

## 15. File Structure

```
apps/platform/integration-hub/
├── src/
│   ├── routes/
│   │   ├── oauth.ts                  # GET /connect/:platform, GET /oauth/:platform/callback, DELETE /accounts/:id
│   │   ├── accounts.ts               # GET /accounts, GET /accounts/:id/campaigns, PUT /accounts/:id/mappings
│   │   ├── webhooks.ts               # POST /webhooks/:platform, GET /webhooks/:platform/verify
│   │   └── backfill.ts               # POST /accounts/:id/backfill, GET /accounts/:id/backfill/:job_id
│   ├── connectors/
│   │   ├── interface.ts              # Connector, SpendRecord, LeadEvent, OAuthTokens types
│   │   ├── registry.ts               # ConnectorRegistry: Map<string, Connector>
│   │   ├── google-ads.ts             # GoogleAdsConnector implements Connector
│   │   ├── meta.ts                   # MetaConnector implements Connector
│   │   ├── clients/
│   │   │   ├── google-ads-client.ts  # GoogleAdsClient typed wrapper around google-ads-api
│   │   │   └── meta-api-client.ts    # MetaApiClient typed wrapper around native fetch
│   ├── services/
│   │   ├── credential-store.ts       # AES-256-GCM encrypt/decrypt; { iv, ciphertext, tag } format
│   │   ├── secrets-provider.ts       # SecretsProvider interface + AwsSecretsProvider + EnvSecretsProvider
│   │   ├── poll-scheduler.ts         # upsertJobScheduler / remove repeatable jobs
│   │   └── event-publisher.ts        # bus.publish() wrappers for ad_lead.received + ad_spend.synced
│   ├── jobs/
│   │   ├── poll-ad-spend.ts
│   │   ├── refresh-token.ts
│   │   ├── process-lead-webhook.ts
│   │   └── backfill-ad-spend.ts
│   ├── plugins/
│   │   └── jwt-auth.ts               # Fastify preHandler plugin; static or JWKS mode
│   ├── repositories/
│   │   ├── accounts.ts               # integration_accounts CRUD
│   │   ├── mappings.ts               # campaign_location_mappings CRUD
│   │   ├── failed-webhooks.ts        # failed_webhooks insert
│   │   └── backfill-jobs.ts          # backfill_jobs insert + progress update + read
│   └── index.ts
├── migrations/
│   ├── 001_create_integration_accounts.ts
│   ├── 002_create_campaign_location_mappings.ts
│   ├── 003_create_failed_webhooks.ts
│   └── 004_create_backfill_jobs.ts
├── test/
│   └── unit/
│       ├── credential-store.test.ts     # encrypt/decrypt round-trip
│       ├── oauth-state.test.ts          # state sign + verify + expiry
│       ├── google-ads-connector.test.ts # parseLeadWebhook, verifyWebhook, verifyChallenge
│       └── meta-connector.test.ts       # parseLeadWebhook, verifyWebhook, verifyChallenge
├── Dockerfile
├── package.json
└── tsconfig.json

packages/@ortho/types/src/
└── events.ts                            # AdLeadReceivedEvent + AdSpendSyncedEvent added
```

---

## 16. Test Scope

**Unit tests only** for this implementation pass. Integration tests are a separate story.

| Test file | What it covers |
|---|---|
| `credential-store.test.ts` | `encrypt()` / `decrypt()` round-trip; IV uniqueness per call; wrong-key rejection |
| `oauth-state.test.ts` | State sign + verify; signature tamper detection; 10-minute expiry rejection |
| `google-ads-connector.test.ts` | `parseLeadWebhook` with valid/malformed payloads; `verifyWebhook` with correct/incorrect shared secret; `verifyChallenge` |
| `meta-connector.test.ts` | `parseLeadWebhook` with valid/batched/malformed payloads; `verifyWebhook` HMAC check; `verifyChallenge` |

Job handlers (`poll-ad-spend`, `process-lead-webhook`, `backfill-ad-spend`) are tested via unit tests with mocked repository functions, mocked connector methods, and `MockDriver` from `@ortho/event-bus`.

---

## 17. Observability

All failure paths log structured errors using `@ortho/logger`:

```ts
log.error({ account_id, platform, err }, 'poll-ad-spend failed')
log.error({ account_id, platform, err }, 'refresh-token failed')
log.warn({ platform, error: err.message }, 'webhook parse failed — body persisted to failed_webhooks')
```

Datadog log-based monitors are configured in the Datadog setup (not in service code). No `dogstatsd` custom metrics required from the service itself.

Child loggers are used in route handlers for request-scoped correlation:
```ts
const reqLog = log.child({ requestId: req.id })
```
