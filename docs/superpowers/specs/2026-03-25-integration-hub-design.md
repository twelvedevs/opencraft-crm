# Integration Hub — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Platform-layer Integration Hub — OAuth credential management, webhook ingestion, ad spend polling, historical backfill, pluggable connector model

---

## 1. Overview

The Integration Hub is a **platform-layer service** (`apps/platform/integration-hub`) that connects external advertising platforms to the Ortho CRM analytics and lead capture pipelines. It is fully domain-agnostic — it has no knowledge of leads, pipelines, or coordinators.

**Core responsibilities:**
- OAuth credential management: authorize external ad accounts, store encrypted tokens, refresh before expiry
- Webhook ingestion: receive real-time lead events from Meta Lead Ads and Google Ads lead forms, verify signatures, publish to EventBridge
- Ad spend polling: pull campaign-level spend, impression, and click data every 4 hours via BullMQ repeatable jobs
- Historical backfill: manually triggered date-range import of historical spend data

**Initial adapters:** Google Ads API, Meta Marketing API

**Events published:**
- `ad_lead.received` → consumed by Lead Service
- `ad_spend.synced` → consumed by Analytics Service

**Out of scope:**
- Ortho-specific metric computation (cost per lead, ROAS) — owned by Reporting Service
- Lead deduplication and CRM record creation — owned by Lead Service
- Dashboard UI — owned by Reporting Service

---

## 2. Architecture

```
Meta / Google Ads
      │
      ├─── Webhook push ──► POST /integrations/webhooks/:platform
      │                          │ verify signature
      │                          │ parseLeadWebhook() [sync, pure, in route handler]
      │                          │ enqueue one process-lead-webhook job per LeadEvent
      │                          └──► BullMQ ──► resolve location_id from mappings
      │                                              │
      │                                              └──► EventBridge: ad_lead.received
      │                                                        │
      │                                                    Lead Service
      │
      └─── Polling (every 4h) ◄── BullMQ repeatable job per account
                                        │ fetchSpend()
                                        └──► EventBridge: ad_spend.synced
                                                  │
                                              Analytics Service
```

### 2.1 Connector Interface

Each platform adapter implements a TypeScript interface. Adding a new connector requires implementing the interface and registering it in the `ConnectorRegistry` — no core service changes.

```typescript
interface Connector {
  platform: string

  // OAuth
  getAuthorizationUrl(state: string): string
  exchangeCode(code: string): Promise<OAuthTokens>
  refreshTokens(account: IntegrationAccount): Promise<OAuthTokens>

  // Polling
  fetchSpend(account: IntegrationAccount, date: string): Promise<SpendRecord[]>
  fetchSpendRange(account: IntegrationAccount, from: string, to: string): Promise<SpendRecord[]>

  // Webhooks
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): boolean
  parseLeadWebhook(payload: unknown): LeadEvent[]
}
```

`ConnectorRegistry` is a `Map<string, Connector>` populated at startup. Routes dispatch to the connector for the requested `:platform` — unknown platforms return `400`.

### 2.2 Supported Connectors

**Google Ads (`google_ads`):**
- OAuth 2.0 with offline access (refresh token). Token refresh via `refresh-token` BullMQ job 30 minutes before expiry.
- Spend data: Google Ads API `GoogleAdsService.search` — campaign performance report with `metrics.cost_micros`, `metrics.impressions`, `metrics.clicks` per campaign per day.
- Lead forms: webhook push to `POST /integrations/webhooks/google_ads`. Signature verification via shared secret configured in Google Ads lead form settings.

**Meta (`facebook_ads`):**
- OAuth 2.0 with long-lived user access token (60-day expiry). No `refresh-token` job registered for Meta accounts.
- Spend data: Marketing API `/act_{account_id}/insights` — `spend`, `impressions`, `clicks`, `campaign_id`, `campaign_name` per day.
- Lead Ads: webhook push to `POST /integrations/webhooks/facebook_ads`. Signature verification via `X-Hub-Signature-256` (HMAC-SHA256 of raw body using app secret). Meta webhook subscription verification challenge handled at `GET /integrations/webhooks/meta/verify`.
- Token expiry: long-lived tokens have a 60-day expiry. There is no automatic refresh path — when a poll fails with an auth error, `status` is set to `'error'` and recovery requires manual reconnect via the UI.

---

## 3. Data Model

Schema: `platform_integrations`

### 3.1 `integration_accounts`

One row per connected ad account.

```sql
id               uuid         PRIMARY KEY DEFAULT gen_random_uuid()
platform         text         NOT NULL                    -- 'google_ads' | 'facebook_ads'
account_id       text         NOT NULL                    -- platform-native account ID
account_name     text                                     -- cached for display
access_token     text         NOT NULL                    -- AES-256-GCM encrypted
refresh_token    text                                     -- AES-256-GCM encrypted; null for Meta long-lived tokens
token_expires_at timestamptz
status           text         NOT NULL DEFAULT 'active'   -- 'active' | 'paused' | 'error'
last_error       text                                     -- most recent polling or auth error
last_polled_at   timestamptz
created_at       timestamptz  NOT NULL DEFAULT now()

UNIQUE (platform, account_id)
```

`status = 'error'` is set when token refresh fails (Google Ads) or polling fails with an auth error (Meta). Polling is halted for the account. For Google Ads: the `refresh-token` job continues to retry — if token refresh succeeds, `status` is cleared and polling resumes. For Meta: recovery requires manual reconnect via the UI (no automatic refresh path). `status` is cleared on the next successful poll.

### 3.2 `campaign_location_mappings`

Maps platform campaigns to location IDs. Location IDs are opaque strings to this service.

```sql
id            uuid  PRIMARY KEY DEFAULT gen_random_uuid()
account_id    uuid  NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE
campaign_id   text  NOT NULL    -- platform-native campaign ID
campaign_name text              -- cached for display; overwritten each poll cycle
location_id   text  NOT NULL    -- opaque; provided by the CRM shell via the UI component

UNIQUE (account_id, campaign_id)
```

**One-to-one constraint:** each campaign maps to exactly one `location_id`. This is intentional — campaigns spanning multiple locations must be split into separate campaigns at the ad platform level for accurate per-location attribution. The `<CampaignLocationMapper>` UI enforces this by providing a single location selector per campaign.

**Unmapped campaigns:** campaigns with no mapping entry are polled but **not published** in `ad_spend.synced`. Their spend data is silently dropped until a location mapping is configured. The `<CampaignLocationMapper>` UI surfaces all campaigns for an account (including unmapped ones) so operators can configure mappings. Once mapped, spend appears in the next poll cycle.

**Re-mapping:** changing a campaign's `location_id` takes effect from the next poll cycle forward. Historical spend already published to Analytics under the old `location_id` is not retroactively re-attributed — the Analytics rollup table retains the original attribution. This is a known limitation: operators should configure mappings correctly before campaigns accumulate significant history.

---

## 4. API

All endpoints except webhooks require a valid Identity Service JWT.

### 4.1 OAuth Flow

| Method | Path | Description |
|---|---|---|
| `GET` | `/integrations/connect/:platform` | Build OAuth authorization URL with PKCE state; redirect browser to platform |
| `GET` | `/integrations/oauth/:platform/callback` | Exchange authorization code for tokens; store encrypted; register BullMQ poll job; redirect to UI |
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
| `POST` | `/integrations/accounts/:id/backfill` | Queue a one-off backfill job. Body: `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD" }`. Max range: 24 months. Returns `{ job_id }`. |
| `GET` | `/integrations/accounts/:id/backfill/:job_id` | Return current BullMQ job state: `{ job_id, status: "active" \| "completed" \| "failed", progress: { chunks_done, chunks_total }, error?: string }`. Used by `<BackfillTrigger>` to poll progress without direct Redis access from the browser. |

### 4.4 Webhooks (no JWT — signature-verified)

| Method | Path | Description |
|---|---|---|
| `POST` | `/integrations/webhooks/:platform` | Receive webhook push from Google or Meta. Verify signature synchronously; return `200` immediately; enqueue `process-lead-webhook` BullMQ job for async processing. |
| `GET` | `/integrations/webhooks/meta/verify` | Meta webhook subscription verification. Returns `hub.challenge` if `hub.verify_token` matches configured secret. |

Signature verification happens before any processing. Invalid signature → `403`, no job enqueued.

After verification, the route handler calls `connector.parseLeadWebhook(payload)` synchronously — this is a pure, I/O-free parsing function. It receives `LeadEvent[]` (Meta delivers batched payloads; Google delivers single leads). One `process-lead-webhook` BullMQ job is enqueued per `LeadEvent`, keyed by `{platform}:{external_lead_id}`. If `parseLeadWebhook` throws (malformed payload), the error is logged and `200` is still returned — Google and Meta will not retry on `200`, so returning a non-200 would cause infinite retries on unrecoverable malformed data. The raw body is logged at `warn` level for debugging.

---

## 5. BullMQ Jobs

Integration Hub uses four job types. BullMQ is already in the stack (Automation Engine, Nurturing Engine, Analytics, Audience).

### 5.1 `poll-ad-spend`

**Schedule:** Repeatable, per account, every 4 hours. Registered on account connect; removed on account disconnect.

**Execution:**
1. Load account + decrypted tokens from `integration_accounts`
2. Call `connector.fetchSpend(account, today)` and `connector.fetchSpend(account, yesterday)` — yesterday included to capture delayed reporting from platforms
3. Look up `campaign_location_mappings` for this account
4. Group records by `location_id`; drop unmapped campaigns (no mapping entry)
5. Publish one `ad_spend.synced` event per `(platform, location_id, date)` to EventBridge — `platform` (from `account.platform`) and `location_id` are top-level envelope fields alongside `synced_date`; `records[]` contains only campaign-level fields
6. Update `last_polled_at = now()` and `status = 'active'`

**On failure:** Set `status = 'error'`, write error message to `last_error`, trigger Datadog alert.

### 5.2 `refresh-token`

**Type:** Delayed one-off job (not a repeatable job). BullMQ `delay` is calculated as `ms until token_expires_at - 30 minutes`. Registered when an account is connected and after each successful refresh. Removed when an account is disconnected (using BullMQ's job ID `refresh-token:{account_id}` to locate and remove it).

**Execution:** Call `connector.refreshTokens(account)` → write new `access_token`, `refresh_token`, `token_expires_at` → enqueue the next `refresh-token` delayed job using the new `token_expires_at`. On failure: set `status = 'error'`, trigger Datadog alert — polling will fail until the account is manually reconnected.

Not registered for Meta accounts (long-lived tokens have a 60-day expiry). When a Meta poll fails with an auth error (401/token-invalid), `status` is set to `'error'` and polling halts. Recovery requires manual reconnect via the UI — there is no automatic token refresh path for Meta.

### 5.3 `process-lead-webhook`

**Type:** One-off per lead. Created by the webhook route handler — one job per `LeadEvent` returned by `parseLeadWebhook()`.

**Execution:**
1. Receive `LeadEvent` (already parsed; payload extracted by route handler before enqueue)
2. Look up `location_id` from `campaign_location_mappings` (null if unmapped)
3. Publish `ad_lead.received` to EventBridge

**Idempotency:** Job ID is set to `{platform}:{external_lead_id}`. BullMQ silently rejects duplicate job IDs — duplicate webhook deliveries (Meta retries on non-200 delivery, Google may redeliver) produce no duplicate events.

### 5.4 `backfill-ad-spend`

**Type:** One-off. Created by `POST /integrations/accounts/:id/backfill`.

**Execution:** Iterate requested date range in 7-day chunks to stay within platform API rate limits. For each chunk, call `connector.fetchSpendRange(account, from, to)`. After each chunk, apply the same grouping logic as `poll-ad-spend`: group records by `location_id`, drop unmapped campaigns, publish one `ad_spend.synced` event per `(location_id, date)`. Events from backfill are identical in structure to events from polling — Analytics Service handler is unchanged. Progress visible via `GET /integrations/accounts/:id/backfill/:job_id`.

---

## 6. Event Payloads

### 6.1 `ad_spend.synced`

Published by `poll-ad-spend` and `backfill-ad-spend`. One event per `(platform, location_id, date)`. Analytics Service `AdSpendSyncedHandler` reads `platform`, `location_id`, and `synced_date` from the envelope and upserts each record — re-syncs are idempotent.

```json
{
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
```

### 6.2 `ad_lead.received`

Published by `process-lead-webhook`. Lead Service creates or updates a lead record from this event.

```json
{
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
```

`location_id` is `null` when no campaign mapping exists. `ad_set_id`, `ad_id`, and `form_id` are Meta-specific — these fields are absent for Google Ads lead events. Lead Service uses whatever fields are present for attribution.

---

## 7. Credential Security

- `access_token` and `refresh_token` stored encrypted with AES-256-GCM
- Encryption key loaded from AWS Secrets Manager at startup via `INTEGRATION_HUB_ENCRYPTION_KEY` env var
- Raw tokens are never written to logs, never returned in API responses
- `GET /integrations/accounts` returns account metadata only — no token fields

---

## 8. UI Component — `@platform/integration-hub-ui`

Four exported React components. All call Integration Hub REST endpoints directly — no proxy through CRM API Gateway. Auth uses the same Identity Service JWT the CRM shell already holds.

**`<ConnectedAccounts />`**
Lists all connected accounts. Shows platform logo, account name, status badge (`active` / `error` / `paused`), `last_polled_at`, `last_error` (when in error state). Disconnect button per account. Primary entry point for the settings page.

**`<OAuthConnectButton platform onSuccess />`**
Renders a "Connect Google Ads" or "Connect Meta Ads" button. On click, redirects to `GET /integrations/connect/:platform`. After the OAuth callback redirects back, calls `onSuccess`.

**`<CampaignLocationMapper accountId locations onSave />`**
Table UI: one row per campaign fetched from `GET /integrations/accounts/:id/campaigns`. A `<select>` per row allows the user to assign a location. "Save" calls `PUT /integrations/accounts/:id/mappings`. The `locations` prop is provided by the CRM shell as `Array<{ id: string; name: string }>` — the component has no knowledge of what a location is.

**`<BackfillTrigger accountId onComplete />`**
Date range picker (`from` / `to`, max 24 months lookback). "Run Historical Sync" button calls `POST /integrations/accounts/:id/backfill`. Polls BullMQ job status until `completed` or `failed`; shows progress indicator.

---

## 9. Cross-Service Dependencies

| Dependency | Type | Notes |
|---|---|---|
| Analytics Service | EventBridge consumer (`ad_spend.synced`) | Payload: `platform`, `location_id`, `synced_date` (top-level envelope) + `records[]` with `campaign_id`, `campaign_name`, `spend`, `impressions`, `clicks`. One event per `(platform, location_id, date)`. Unmapped campaigns are not published. |
| Lead Service | EventBridge consumer (`ad_lead.received`) | Lead Service must handle `location_id: null` gracefully (unmapped campaigns) |
| Identity Service | JWT validation | All non-webhook endpoints require a valid JWT |
| AWS Secrets Manager | Startup credential load | `INTEGRATION_HUB_ENCRYPTION_KEY` fetched at service startup |

---

## 10. File Structure

```
apps/platform/integration-hub/
├── src/
│   ├── routes/
│   │   ├── oauth.ts                  # GET /connect/:platform, GET /oauth/:platform/callback, DELETE /accounts/:id
│   │   ├── accounts.ts               # GET /accounts, GET /accounts/:id/campaigns, PUT /accounts/:id/mappings
│   │   ├── webhooks.ts               # POST /webhooks/:platform, GET /webhooks/meta/verify
│   │   └── backfill.ts               # POST /accounts/:id/backfill, GET /accounts/:id/backfill/:job_id
│   ├── connectors/
│   │   ├── interface.ts              # Connector interface + SpendRecord, LeadEvent, OAuthTokens types
│   │   ├── registry.ts               # ConnectorRegistry: Map<string, Connector>
│   │   ├── google-ads.ts             # GoogleAdsConnector implements Connector
│   │   └── meta.ts                   # MetaConnector implements Connector
│   ├── services/
│   │   ├── credential-store.ts       # AES-256-GCM encrypt/decrypt for token fields
│   │   ├── poll-scheduler.ts         # register/remove BullMQ repeatable jobs per account
│   │   └── event-publisher.ts        # EventBridge publish helpers for both event types
│   ├── jobs/
│   │   ├── poll-ad-spend.ts
│   │   ├── refresh-token.ts
│   │   ├── process-lead-webhook.ts
│   │   └── backfill-ad-spend.ts
│   ├── repositories/
│   │   ├── accounts.ts               # integration_accounts CRUD
│   │   └── mappings.ts               # campaign_location_mappings CRUD
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json

packages/@platform/integration-hub-ui/
├── src/
│   ├── ConnectedAccounts.tsx
│   ├── OAuthConnectButton.tsx
│   ├── CampaignLocationMapper.tsx
│   ├── BackfillTrigger.tsx
│   └── index.ts
├── package.json
└── tsconfig.json
```
