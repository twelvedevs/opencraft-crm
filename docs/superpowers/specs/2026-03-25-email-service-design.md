# Email Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Platform-layer Email Service — transactional and bulk email delivery via SendGrid, per-recipient campaign tracking, bounce/engagement webhook processing, sending domain management

---

## 1. Overview

The Email Service is a **platform-layer service** (`apps/platform/email`) responsible for all email delivery via SendGrid. It is fully generic — it has no knowledge of Ortho CRM concepts such as leads, pipeline stages, or coordinators.

**Core responsibilities:**
- Send transactional emails immediately (single recipient, pre-rendered HTML)
- Accept bulk campaign send jobs and process them asynchronously with per-recipient tracking
- Process SendGrid delivery and engagement webhooks; publish normalized events to EventBridge
- Manage per-location SendGrid sending domain configuration
- Expose a spam score check endpoint (used by Campaign builder UI and as an automatic gate on bulk sends)

**Out of scope:**
- Template storage and rendering for transactional sends (callers pre-render and pass HTML)
- Active hours enforcement (callers handle timing before calling this service)
- Unsubscribe list storage (Email Service publishes `email.unsubscribed`; Lead Service owns opt-out state)
- SendGrid Marketing Campaigns API (all bulk delivery is managed directly via `/v3/mail/send`)

---

## 2. Architecture

```
Callers: Automation Engine, Nurturing Engine, Reporting Service
        │  POST /emails/send (pre-rendered HTML + subject)
        │
Campaign Service
        │  POST /emails/campaigns/send (template_id + recipient list)
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│                    Email Service                          │
│   apps/platform/email                                    │
│                                                          │
│  REST API (Fastify)                                      │
│  ├── POST /emails/send                                   │
│  ├── POST /emails/campaigns/send                         │
│  ├── POST /emails/spam-check                             │
│  ├── GET  /emails/campaigns/:jobId                       │
│  ├── GET  /emails/campaigns/:jobId/recipients            │
│  └── POST /webhooks/sendgrid                             │
│                                                          │
│  BullMQ Queues (Redis)                                   │
│  ├── transactional-send  → Transactional Worker         │
│  └── campaign-recipient  → Campaign Recipient Worker    │
│                                                          │
│  Webhook Handler                                         │
│  └── updates send/recipient rows → publishes events     │
└──────────────────────────────────────────────────────────┘
         │                         │
    SendGrid API             AWS EventBridge
                     (email.sent, email.delivered,
                      email.opened, email.clicked,
                      email.bounced, email.unsubscribed,
                      email.spam_reported, email.failed)
```

**Key architectural decisions:**

- **Transactional sends use pre-rendered HTML** — callers (Automation Engine, Nurturing Engine) render content themselves before calling `POST /emails/send`. Consistent with the Messaging Service pattern — no template IDs at this layer.
- **Campaign sends pass `template_id` + per-recipient context** — Email Service calls Template Service per recipient during async BullMQ job processing. Avoids large pre-rendered payloads from callers.
- **Single SendGrid account with per-location sending domains** — authenticated sending domain per location stored in `email_sending_domains`. 34 locations do not warrant SendGrid subuser overhead.
- **Email Service is the single SendGrid contact point** — both outbound sends and inbound webhooks. All consumers receive normalized EventBridge events; no direct SendGrid dependency outside this service.

---

## 3. API

### 3.1 Transactional Send

```
POST /emails/send
{
  "dedup_key": "{{event_id}}-email",   // required — idempotency key
  "location_id": "loc_123",
  "to": "jane@example.com",
  "subject": "Your free exam is confirmed",
  "html": "<html>...</html>",
  "text": "Your free exam is confirmed..."  // plain text fallback, required
}

→ 200 { "email_id": "uuid", "status": "queued" }
→ 200 { "email_id": "uuid", "status": "queued" }  // duplicate dedup_key — same response, no re-send
→ 422 { "error": "domain_not_configured", "location_id": "loc_123" }
```

Flow:
1. Resolve sending domain by `location_id` — fail fast with `422` if not configured
2. Check `dedup_key` uniqueness — return existing row if already present
3. Insert `email_sends` row (status: `queued`)
4. Enqueue BullMQ transactional-send job
5. Worker calls SendGrid `/v3/mail/send` with resolved `from` address
6. On success: update status → `sent`, store `sendgrid_message_id`, publish `email.sent`
7. On transient failure: BullMQ retry with exponential backoff (5s → 30s → 2m → 10m), increment `attempt`
8. On max retries: status → `failed`, publish `email.failed`

### 3.2 Campaign (Bulk) Send

```
POST /emails/campaigns/send
{
  "job_ref": "campaign_456",           // caller's reference ID — idempotency key
  "location_id": "loc_123",
  "template_id": "post-exam-email",
  "subject_template": "{{first_name}}, your treatment plan is ready",
  "recipients": [
    { "email": "jane@example.com", "context": { "first_name": "Jane", ... } },
    ...
  ],
  "scheduled_for": "2026-03-26T10:00:00Z"  // optional — null = send immediately
}

→ 202 { "job_id": "uuid", "status": "pending", "total_recipients": 5000 }
→ 200 { "job_id": "uuid", "status": "processing" }   // duplicate job_ref — idempotent
→ 422 { "error": "spam_check_failed", "score": 8.2, "threshold": 5.0, "issues": [...] }
→ 422 { "error": "domain_not_configured", "location_id": "loc_123" }
```

Flow:
1. Resolve sending domain by `location_id` — fail fast with `422` if not configured
2. Check `job_ref` uniqueness — return existing job if already present
3. Run spam check on one rendered sample recipient — return `422` if score exceeds threshold
4. Insert `email_campaign_jobs` row + bulk-insert `email_campaign_recipients` (all status: `pending`)
5. Enqueue BullMQ campaign-recipient jobs (one per recipient) with delay if `scheduled_for` is in the future
6. Campaign Recipient Worker per recipient: render template via Template Service → call SendGrid → update recipient row → increment `sent_count` on parent job
7. When `sent_count + failed_count = total_recipients`: update job status → `completed` or `completed_with_errors`

```
GET /emails/campaigns/:jobId
→ {
    "job_id": "uuid",
    "status": "processing",
    "total_recipients": 5000,
    "sent_count": 3241,
    "failed_count": 12
  }

GET /emails/campaigns/:jobId/recipients?status=bounced&page=1
→ { "recipients": [...], "total": 47, "page": 1 }

DELETE /emails/campaigns/:jobId
→ 200   // cancels pending job — sets status → cancelled, removes BullMQ delayed jobs
→ 409   // cannot cancel a job already in processing or completed
```

### 3.3 Spam Check

```
POST /emails/spam-check
{
  "subject": "Limited time offer — free exam",
  "html": "<html>...</html>",
  "text": "..."
}

→ 200 {
    "score": 3.1,
    "threshold": 5.0,
    "passed": true,
    "issues": [
      { "rule": "HTML_IMAGE_ONLY", "description": "Message is image-only", "score": 1.2 }
    ]
  }
```

Uses SpamScanner (Node-native npm package — no external service dependency). Called by the Campaign builder UI on demand and automatically at the start of `POST /emails/campaigns/send`. Threshold is configurable via environment variable (default: 5.0).

### 3.4 Sending Domains

```
POST /emails/domains
{ "location_id": "loc_123", "domain": "mail.drortho.com",
  "from_name": "Dr. Ortho", "from_email": "hello@mail.drortho.com" }
→ 201 { "id": "uuid", "is_verified": false }

GET  /emails/domains          → list all domains with verification status
GET  /emails/domains/:id      → single domain with live verification status from SendGrid
DELETE /emails/domains/:id    → 409 if domain has sent emails in last 30 days
```

Domain verification status (`is_verified`) is checked against the SendGrid domain authentication API on GET. A domain must be verified before it can be used for sends — `POST /emails/send` and `POST /emails/campaigns/send` fail with `422` if the resolved domain is unverified.

---

## 4. Database Schema — `platform_email`

```sql
-- Per-location sending domain configuration
email_sending_domains (
  id              uuid PRIMARY KEY,
  location_id     text NOT NULL UNIQUE,
  domain          text NOT NULL,
  from_name       text NOT NULL,
  from_email      text NOT NULL,    -- e.g. hello@mail.drortho.com
  is_verified     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
)

-- Transactional send log
email_sends (
  id                   uuid PRIMARY KEY,
  dedup_key            text UNIQUE,
  location_id          text NOT NULL,
  to_email             text NOT NULL,
  subject              text NOT NULL,
  sendgrid_message_id  text,
  status               text NOT NULL DEFAULT 'queued',
    -- queued | sent | delivered | bounced | failed
  attempt              integer NOT NULL DEFAULT 0,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
)

-- Campaign bulk send jobs
email_campaign_jobs (
  id                uuid PRIMARY KEY,
  job_ref           text UNIQUE,           -- caller idempotency key
  location_id       text NOT NULL,
  template_id       text NOT NULL,
  subject_template  text NOT NULL,
  domain_id         uuid REFERENCES email_sending_domains NOT NULL,
  scheduled_for     timestamptz,           -- NULL = send immediately
  spam_score        numeric,
  spam_issues       jsonb,
  status            text NOT NULL DEFAULT 'pending',
    -- pending | spam_check_failed | processing | completed | completed_with_errors | failed | cancelled
  total_recipients  integer NOT NULL DEFAULT 0,
  sent_count        integer NOT NULL DEFAULT 0,
  failed_count      integer NOT NULL DEFAULT 0,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  completed_at      timestamptz
)

-- Per-recipient tracking
email_campaign_recipients (
  id                   uuid PRIMARY KEY,
  job_id               uuid REFERENCES email_campaign_jobs NOT NULL,
  to_email             text NOT NULL,
  context              jsonb NOT NULL,     -- merge data snapshot at insert time
  sendgrid_message_id  text,
  status               text NOT NULL DEFAULT 'pending',
    -- pending | sent | delivered | opened | clicked | bounced | failed | unsubscribed
  attempt              integer NOT NULL DEFAULT 0,
  error                text,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  opened_at            timestamptz,
  clicked_at           timestamptz,        -- timestamp of first click
  bounced_at           timestamptz
)

-- Individual link clicks per recipient (for click map analytics)
email_recipient_clicks (
  id            uuid PRIMARY KEY,
  recipient_id  uuid REFERENCES email_campaign_recipients NOT NULL,
  url           text NOT NULL,
  clicked_at    timestamptz NOT NULL DEFAULT now()
)

-- Indexes
CREATE INDEX ON email_sends (sendgrid_message_id);
CREATE INDEX ON email_campaign_recipients (job_id, status);
CREATE INDEX ON email_campaign_recipients (sendgrid_message_id);
CREATE INDEX ON email_recipient_clicks (recipient_id);
```

**Notes:**
- `email_sends.sendgrid_message_id` indexed for fast webhook correlation
- `email_campaign_recipients (job_id, status)` supports progress polling and status-filtered queries (e.g. all bounced recipients for a campaign)
- `email_campaign_recipients.context` is a snapshot at insert time — never updated after insert
- No hard deletes — all rows serve as audit log

---

## 5. SendGrid Webhook Handling

SendGrid delivers all engagement events (delivered, open, click, bounce, unsubscribe, spam report) as POST batches to `POST /webhooks/sendgrid`.

### 5.1 Processing Flow

```
SendGrid POST /webhooks/sendgrid
  → Verify ECDSA signature (signing key from AWS Secrets Manager)
  → Parse event batch (SendGrid sends arrays of events)
  → For each event:
      1. Look up email_sends OR email_campaign_recipients by sendgrid_message_id
      2. Update row status + timestamp (ON CONFLICT DO NOTHING for idempotency)
      3. For click events: insert email_recipient_clicks row
      4. For campaign recipients: update sent_count / failed_count on parent job
      5. Publish EventBridge event
  → Return 200 (always — SendGrid retries on non-2xx)
```

Webhook processing is synchronous in-request. If a `sendgrid_message_id` is not found (rare race between send and webhook arrival), the event is logged and dropped. SendGrid does not retry delivered/open/click events, making this an acceptable data loss boundary.

### 5.2 EventBridge Events Published

All events use the standard `@ortho/event-bus` envelope: `{ event_id, event_type, entity_type, entity_id, timestamp, payload }`.

| Event | Trigger | Key Payload Fields |
|---|---|---|
| `email.sent` | SendGrid accepted the message | `email_id`, `to_email`, `location_id`, `dedup_key` |
| `email.delivered` | SendGrid confirms delivery to inbox | `email_id`, `to_email`, `location_id`, `campaign_job_id?` |
| `email.opened` | Recipient opens email (pixel) | `email_id`, `to_email`, `location_id`, `campaign_job_id?` |
| `email.clicked` | Recipient clicks a tracked link | `email_id`, `to_email`, `url`, `location_id`, `campaign_job_id?` |
| `email.bounced` | Hard bounce | `email_id`, `to_email`, `location_id`, `bounce_type: hard\|soft` |
| `email.unsubscribed` | Recipient clicks unsubscribe | `to_email`, `location_id` |
| `email.spam_reported` | Recipient marks as spam | `to_email`, `location_id` |
| `email.failed` | Max retries exceeded (transactional) | `email_id`, `to_email`, `dedup_key`, `error` |

**Subscribers:**
- `email.bounced` → Lead Service (flags lead email as undeliverable)
- `email.unsubscribed`, `email.spam_reported` → Lead Service (sets email opt-out flag)
- `email.delivered`, `email.opened`, `email.clicked` → Analytics Service (engagement metrics)
- `email.failed` → Datadog alert via dead-letter monitoring

### 5.3 Bounce Handling

| SendGrid Event | Classification | Email Service Action |
|---|---|---|
| `bounce` | Hard (permanent) | Status → `bounced`, publish `email.bounced { bounce_type: "hard" }` |
| `deferred` | Soft (temporary) | No status change — SendGrid retries automatically |
| `spamreport` | Spam | Status → `bounced`, publish `email.spam_reported` |

Hard bounces are not retried. SendGrid automatically suppresses the address; future sends to that address are rejected by SendGrid with a 400.

---

## 6. Fault Handling & Idempotency

### Transactional Send

| Scenario | Behaviour |
|---|---|
| Duplicate `dedup_key` | UNIQUE constraint — return existing row with `200`, no re-send |
| SendGrid transient error (5xx, timeout) | BullMQ retry: 5s → 30s → 2m → 10m; `attempt` incremented |
| SendGrid permanent error (4xx) | No retry. Status → `failed`, `error` populated, publish `email.failed` |
| Worker crash mid-send | Job not ACKed — re-queued on restart. `dedup_key` prevents double-send |
| `location_id` has no configured domain | `422` before enqueue — no BullMQ job created |

### Campaign Send

| Scenario | Behaviour |
|---|---|
| Duplicate `job_ref` | UNIQUE constraint — return existing job with `200`, no re-processing |
| Spam check fails | Job status → `spam_check_failed`, `422` returned. No recipients inserted, no jobs enqueued |
| Worker crash mid-campaign | On restart, worker queries `WHERE job_id = ? AND status = 'pending'` and re-enqueues remaining |
| Individual recipient send fails | Recipient status → `failed`, `failed_count` incremented. Other recipients continue unaffected |
| Template Service unavailable | BullMQ retry for that recipient. Parent job remains `processing` |
| All recipients fail | Job status → `failed` |
| Some recipients sent, some failed | Job status → `completed_with_errors` |
| Scheduled job cancelled | Status → `cancelled`, BullMQ delayed jobs removed. Only allowed before `processing` starts |

### Webhook Idempotency

SendGrid delivers webhooks at-least-once. Status updates use `ON CONFLICT DO NOTHING` — a duplicate `delivered` event for an already-delivered recipient is a no-op. Click events are always inserted (multiple clicks tracked individually in `email_recipient_clicks`).

---

## 7. Infrastructure & Service Layout

```
apps/platform/email/
├── src/
│   ├── routes/
│   │   ├── sends.ts               # POST /emails/send
│   │   ├── campaigns.ts           # POST /emails/campaigns/send, GET status/recipients, DELETE
│   │   ├── spam-check.ts          # POST /emails/spam-check
│   │   ├── domains.ts             # CRUD /emails/domains
│   │   └── webhooks.ts            # POST /webhooks/sendgrid
│   ├── services/
│   │   ├── sendgrid-client.ts     # SendGrid API wrapper
│   │   ├── spam-scanner.ts        # SpamScanner wrapper
│   │   ├── domain-resolver.ts     # location_id → sending domain lookup (in-memory cache, 60s TTL)
│   │   └── webhook-processor.ts   # parse + route SendGrid webhook events
│   ├── workers/
│   │   ├── transactional-send.worker.ts   # BullMQ worker
│   │   └── campaign-recipient.worker.ts   # BullMQ worker
│   ├── repositories/
│   │   ├── sends.repo.ts
│   │   ├── campaigns.repo.ts
│   │   ├── recipients.repo.ts
│   │   └── domains.repo.ts
│   ├── events/
│   │   └── publisher.ts           # EventBridge event publishing
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `platform_email` schema)
- Redis (BullMQ — ElastiCache or ECS sidecar)
- AWS EventBridge (outbound events)
- AWS Secrets Manager (SendGrid API key, SendGrid webhook signing secret)
- SendGrid API (delivery + domain verification)
- Template Service — `POST /templates/render` (called by campaign recipient worker only)

---

## 8. Testing Strategy

### Unit Tests (Vitest — pure functions, no I/O)

- `spam-scanner.ts` — known spam patterns score above threshold; clean emails pass; threshold boundary cases
- `domain-resolver.ts` — cache hit returns cached domain; cache miss queries DB; missing `location_id` throws; cache TTL expiry triggers re-fetch
- `webhook-processor.ts` — all SendGrid event types (`delivered`, `open`, `click`, `bounce`, `unsubscribe`, `spamreport`) route to correct handler; unknown event type logged and ignored without throwing
- Dedup key logic — duplicate `dedup_key` returns existing row without enqueue

### Integration Tests (Vitest + real Postgres + real Redis, SendGrid mocked via HTTP interceptor)

- **Transactional happy path** — send queued, worker calls SendGrid, row updated to `sent`, `email.sent` published
- **Duplicate `dedup_key`** — second call returns same `email_id`, SendGrid called exactly once
- **Transient SendGrid failure** — worker retries, `attempt` increments, eventual success
- **Max retries exceeded** — status → `failed`, `email.failed` published to EventBridge
- **Unverified domain** — `POST /emails/send` returns `422` before any DB write
- **Campaign happy path** — 3 recipients: all rendered via Template Service, all sent, job → `completed`
- **Campaign partial failure** — one recipient fails permanently, others succeed → `completed_with_errors`, `failed_count = 1`
- **Campaign crash recovery** — pre-insert `pending` recipients, simulate worker crash, restart re-enqueues `pending` rows only
- **Spam check gate** — campaign with high-scoring email returns `422`, no `email_campaign_jobs` row inserted
- **Duplicate `job_ref`** — second call returns existing job, no recipients re-inserted
- **Webhook: `delivered`** — updates recipient `delivered_at`, publishes `email.delivered`
- **Webhook: `bounce`** — updates status → `bounced`, publishes `email.bounced { bounce_type: "hard" }`
- **Webhook: `open`** — updates `opened_at`, publishes `email.opened`
- **Webhook: `click`** — inserts `email_recipient_clicks` row, updates `clicked_at` on first click only; second click inserts second row, does not update `clicked_at`
- **Webhook idempotency** — duplicate `delivered` event is a no-op (no duplicate EventBridge publish)
- **Webhook: unknown event type** — logged, ignored, returns `200`

### Contract Tests

**Outbound:**
- `POST /templates/render` — payload shape (template_id, context) matches Template Service API
- EventBridge event shapes for all 8 event types validated against `@ortho/event-bus` schema

**Inbound:**
- SendGrid webhook payload parsing for all handled event types
- ECDSA signature verification rejects tampered payloads

*Test tooling: `@ortho/testing` package — DB fixtures, Redis fixtures, EventBridge mock, HTTP factory stubs.*

---

## 9. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transactional API shape | Callers pass pre-rendered HTML + subject | Consistent with Messaging Service pattern. Email Service stays thin for single sends. |
| Bulk send approach | Job-orchestrated with per-recipient tracking | Enables resumable jobs, per-recipient analytics, and accurate campaign stats independent of webhook timing. |
| Template rendering for bulk | Email Service calls Template Service per recipient during job processing | Avoids large pre-rendered payload from caller. Single rendering path inside the async worker. |
| Unsubscribe storage | No local suppression table — publish `email.unsubscribed`, Lead Service owns opt-out state | Keeps Email Service stateless about entity opt-out. Callers responsible for passing clean recipient lists. |
| Sending domains | Single SendGrid account, per-location authenticated domains in `email_sending_domains` | 34 locations do not warrant SendGrid subuser overhead. Per-domain authentication still provides deliverability isolation. |
| Webhook integration | Email Service is single SendGrid contact point (outbound + inbound) | All consumers receive normalized EventBridge events — no direct SendGrid dependency outside this service. |
| Spam check | Sync endpoint + automatic gate on campaign send | UI gets real-time feedback during drafting; automatic gate prevents high-scoring campaigns from executing. |
| Active hours | Not enforced by Email Service | Callers (Campaign Service `scheduled_for`, Automation/Nurturing Engine) handle timing. Email Service is a delivery primitive. |
| Bounce handling | Hard bounce → status `failed` + EventBridge event. Soft bounce deferred to SendGrid retry. | Hard bounces are permanent — Lead Service notified via event. Soft bounces resolve at the delivery layer. |
| BullMQ retry | 5s → 30s → 2m → 10m, per send/per recipient | Per-recipient retry prevents one bad address from blocking a campaign. Consistent with Automation Engine retry pattern. |
