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
- Template storage and rendering for transactional sends — callers (Automation Engine, Nurturing Engine) must call `POST /templates/render` on the Template Service themselves and pass the rendered HTML to `POST /emails/send`. The Email Service does not accept `template_id` on `POST /emails/send`. **Note:** the Automation Engine spec's `send_email` action params (`template_id` + `context`) reflect the Automation Engine worker's responsibility to call Template Service before calling this endpoint — the Automation Engine spec must be updated to document this two-step flow.
- Active hours enforcement (callers handle timing before calling this service)
- Unsubscribe list storage (Email Service publishes `email.unsubscribed`; Lead Service owns opt-out state)
- SendGrid Marketing Campaigns API (all bulk delivery is managed directly via `/v3/mail/send`)
- Open and click tracking for transactional sends — engagement tracking is campaign-only (see Section 5.1)

---

## 2. Architecture

```
Callers: Automation Engine, Nurturing Engine, Reporting Service
        │  POST /emails/send (pre-rendered HTML + subject)
        │  (callers render via Template Service before calling)
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
                      email.spam_reported, email.failed,
                      email.campaign_completed)
```

**Key architectural decisions:**

- **Transactional sends use pre-rendered HTML** — callers (Automation Engine, Nurturing Engine) render content via Template Service before calling `POST /emails/send`. Consistent with the Messaging Service pattern — no template IDs at this layer.
- **Campaign sends pass `template_id` + per-recipient context** — Email Service calls Template Service per recipient during async BullMQ job processing. Avoids large pre-rendered payloads from callers.
- **Single SendGrid account with per-location sending domains** — authenticated sending domain per location stored in `email_sending_domains`. 34 locations do not warrant SendGrid subuser overhead.
- **Email Service is the single SendGrid contact point** — both outbound sends and inbound webhooks. All consumers receive normalized EventBridge events; no direct SendGrid dependency outside this service.

---

## 3. API

### 3.1 Transactional Send

Callers must pre-render email content via the Template Service (`POST /templates/render`) before calling this endpoint. The Email Service does not accept template IDs for single sends.

```
POST /emails/send
{
  "dedup_key": "{{event_id}}-email",   // required — idempotency key
  "location_id": "loc_123",
  "to": "jane@example.com",
  "subject": "Your free exam is confirmed",
  "html": "<html>...</html>",
  "text": "Your free exam is confirmed...",  // plain text fallback, required
  "entity_type": "lead",                     // optional — passed through to EventBridge events
  "entity_id": "lead_456"                    // optional — passed through to EventBridge events
}

→ 200 { "email_id": "uuid", "status": "queued" }
→ 200 { "email_id": "uuid", "status": "queued" }  // duplicate dedup_key — same response, no re-send
→ 422 { "error": "domain_not_configured", "location_id": "loc_123" }
→ 422 { "error": "domain_not_verified", "location_id": "loc_123" }
```

`entity_type` and `entity_id` are optional correlation fields. Callers (e.g., Automation Engine, Nurturing Engine) pass the entity they are acting on so that subscribers (e.g., Analytics Service) can correlate `email.sent` / `email.failed` events back to the originating entity. They are stored on the `email_sends` row and included in all EventBridge events for that send.

Flow:
1. Resolve sending domain by `location_id` — fail fast with `422` if not configured or `is_verified = false`
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
→ 200 { "job_id": "uuid", "status": "<current_status>" }  // duplicate job_ref — idempotent, returns current job state
→ 422 { "error": "spam_check_failed", "job_id": "uuid", "score": 8.2, "threshold": 5.0, "issues": [...] }
→ 422 { "error": "domain_not_configured", "location_id": "loc_123" }
→ 422 { "error": "domain_not_verified", "location_id": "loc_123" }
```

Flow:
1. Resolve sending domain by `location_id` — fail fast with `422` if not configured or `is_verified = false`
2. Check `job_ref` uniqueness — return existing job with current status if already present
3. Insert `email_campaign_jobs` row (status: `pending`)
4. Render one sample recipient via Template Service for spam check:
   - Template Service 4xx (e.g. template not found): update job status → `failed`, return `422 { "error": "template_render_failed", "job_id": "..." }`. No recipients inserted, no BullMQ jobs enqueued.
   - Template Service 5xx / timeout: update job status → `failed`, return `503 { "error": "template_service_unavailable", "job_id": "..." }`. Caller may retry with a new `job_ref`.
5. Run spam check on the rendered sample:
   - If score exceeds threshold: update job status → `spam_check_failed`, store `spam_score` + `spam_issues`, return `422`. No recipients inserted, no BullMQ jobs enqueued.
   - If passes: store `spam_score` + `spam_issues` on job row, continue.
6. Bulk-insert `email_campaign_recipients` (all status: `pending`), update `total_recipients` on job row
7. Update job status → `processing`, set `started_at`
8. Enqueue BullMQ campaign-recipient jobs (one per recipient) with delay if `scheduled_for` is in the future
9. Campaign Recipient Worker per recipient: render template via Template Service → call SendGrid → update recipient row status → atomically increment `sent_count` on parent job using `UPDATE ... SET sent_count = sent_count + 1 WHERE id = ?`. On permanent failure: increment `failed_count` instead.
10. After each increment: check job completion atomically (see Section 6)

**`scheduled_for` in the past:** If `scheduled_for` is a timestamp in the past, it is treated as immediate — BullMQ enqueues with zero delay. No `422` is returned.

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
→ 200   // cancels job in pending or spam_check_failed state — sets status → cancelled
→ 409   // cannot cancel a job in processing or any terminal state (completed, completed_with_errors, failed, cancelled)
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

GET  /emails/domains          → list all domains with local is_verified status
GET  /emails/domains/:id      → fetch live verification status from SendGrid, update local is_verified, return result
DELETE /emails/domains/:id    → 409 if domain has sent emails in last 30 days
```

**Verification lifecycle:** `is_verified` in `email_sending_domains` is a local cache of the SendGrid domain authentication status. It starts as `false` on creation. It is updated to `true` when `GET /emails/domains/:id` confirms verification from SendGrid. Pre-send checks (`POST /emails/send`, `POST /emails/campaigns/send`) read the local `is_verified` column — no live SendGrid API call at send time. Operators verify a domain by: registering it in SendGrid, adding DNS records, then hitting `GET /emails/domains/:id` which syncs the status.

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
  domain_id            uuid REFERENCES email_sending_domains,
  entity_type          text,                -- optional correlation field from caller
  entity_id            text,                -- optional correlation field from caller
  to_email             text NOT NULL,
  subject              text NOT NULL,
  sendgrid_message_id  text,
  status               text NOT NULL DEFAULT 'queued',
    -- queued | sent | delivered | bounced | unsubscribed | failed
  attempt              integer NOT NULL DEFAULT 0,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  bounced_at           timestamptz
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
    -- pending | sent | delivered | opened | clicked | bounced | spam_reported | failed | unsubscribed
  attempt              integer NOT NULL DEFAULT 0,
  error                text,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  opened_at            timestamptz,
  clicked_at           timestamptz,        -- timestamp of first click
  bounced_at           timestamptz
)

-- Individual link clicks per campaign recipient (for click map analytics)
email_recipient_clicks (
  id            uuid PRIMARY KEY,
  recipient_id  uuid REFERENCES email_campaign_recipients NOT NULL,
  url           text NOT NULL,
  clicked_at    timestamptz NOT NULL DEFAULT now()
)

-- Indexes
CREATE INDEX ON email_sends (sendgrid_message_id);
CREATE INDEX ON email_sends (status);
CREATE INDEX ON email_sends (domain_id, created_at);      -- domain deletion check + domain-level reporting
CREATE INDEX ON email_campaign_jobs (status);
CREATE INDEX ON email_campaign_jobs (location_id);
CREATE INDEX ON email_campaign_jobs (domain_id, created_at);   -- domain deletion check
CREATE INDEX ON email_campaign_recipients (job_id, status);
CREATE INDEX ON email_campaign_recipients (sendgrid_message_id);
CREATE INDEX ON email_recipient_clicks (recipient_id);
```

**Notes:**
- `email_sends.sendgrid_message_id` indexed for fast webhook correlation
- `email_sends (status)` supports monitoring queries (e.g. find all `queued` sends on restart)
- `email_sends (domain_id, created_at)` and `email_campaign_jobs (domain_id, created_at)` support the domain deletion 30-day check across both tables
- `email_campaign_jobs (status)` supports crash-recovery startup scan (find all `processing` jobs with orphaned `pending` recipients)
- `email_campaign_jobs (location_id)` supports admin/reporting queries by location
- `email_campaign_recipients (job_id, status)` supports progress polling, status-filtered queries, and crash-recovery re-enqueue scan
- `email_campaign_recipients.context` is a snapshot at insert time — never updated after insert
- `email_sends.delivered_at` and `bounced_at` track delivery/bounce timestamps for transactional emails. Open and click events for transactional sends publish EventBridge events only — no status change, no timestamp written. Click tracking table (`email_recipient_clicks`) is campaign-only
- `email_sends.domain_id` is set at insert time from the resolved sending domain. Used for domain deletion check and traceability after domain config changes
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
      1. Determine source: look up email_campaign_recipients by sendgrid_message_id first;
         if not found, look up email_sends by sendgrid_message_id
      2. Update row status + timestamp per event type using forward-only WHERE guards (see Section 6):
           delivered        → status = 'delivered', delivered_at = event_timestamp
           open             → campaign recipient: status = 'opened', opened_at = event_timestamp
                              transactional send: publish event only — no status change, no timestamp column
           click            → campaign recipient: status = 'clicked', clicked_at = event_timestamp (first only)
                              transactional send: publish event only — no status change, no click table
           bounce (hard)    → status = 'bounced', bounced_at = event_timestamp
                              (SendGrid event.type = "bounce")
           bounce (blocked) → no status change, no event published — treated as temporary suppression
                              (SendGrid event.type = "blocked")
           spamreport       → campaign recipient: status = 'spam_reported'
                              transactional send: status = 'bounced', bounced_at = event_timestamp
           unsubscribe      → status = 'unsubscribed'
      3. For click events on campaign recipients: insert email_recipient_clicks row (always — multiple clicks tracked)
      4. Publish EventBridge event

Note: `sent_count` and `failed_count` on `email_campaign_jobs` are incremented exclusively by the Campaign Recipient Worker (tracking SendGrid acceptance/rejection). The webhook handler does NOT touch these counters. Post-delivery bounces and spam reports update the recipient row status only — they are engagement/suppression data, not delivery failure data. This keeps the completion sum (`sent_count + failed_count = total_recipients`) stable after the campaign completes.
  → Return 200 (always — SendGrid retries on non-2xx)
```

Webhook processing is synchronous in-request. If a `sendgrid_message_id` is not found (rare race between send and webhook arrival), the event is logged and dropped. SendGrid does not retry delivered/open/click events, making this an acceptable data loss boundary.

**`sent_count` is incremented exclusively by the Campaign Recipient Worker** after SendGrid accepts the message — not by the webhook handler on `delivered`. This prevents double-counting.

### 5.2 EventBridge Events Published

All events use the standard `@ortho/event-bus` envelope: `{ event_id, event_type, entity_type, entity_id, timestamp, payload }`.

| Event | Trigger | Key Payload Fields |
|---|---|---|
| `email.sent` | SendGrid accepted the message | `email_id`, `to_email`, `location_id`, `entity_type?`, `entity_id?`, `dedup_key` |
| `email.delivered` | SendGrid confirms delivery to inbox | `email_id`, `to_email`, `location_id`, `entity_type?`, `entity_id?`, `campaign_job_id?` |
| `email.opened` | Campaign recipient opens email (pixel) | `email_id`, `to_email`, `location_id`, `entity_type?`, `entity_id?`, `campaign_job_id?` |
| `email.clicked` | Recipient clicks a tracked link | `email_id`, `to_email`, `url`, `location_id`, `entity_type?`, `entity_id?`, `campaign_job_id?` |
| `email.bounced` | Hard bounce (SendGrid `bounce` event) | `email_id`, `to_email`, `location_id`, `bounce_type: "hard"`, `campaign_job_id?` |
| `email.unsubscribed` | Recipient clicks unsubscribe | `to_email`, `location_id` |
| `email.spam_reported` | Recipient marks as spam | `to_email`, `location_id` |
| `email.failed` | Max retries exceeded (transactional) | `email_id`, `to_email`, `location_id`, `entity_type?`, `entity_id?`, `dedup_key`, `error` |
| `email.campaign_completed` | Campaign job reaches terminal state | `job_id`, `job_ref`, `status`, `total_recipients`, `sent_count`, `failed_count`, `location_id` |

**Subscribers:**
- `email.bounced` → Lead Service (flags lead email as undeliverable)
- `email.unsubscribed`, `email.spam_reported` → Lead Service (sets email opt-out flag)
- `email.delivered`, `email.opened`, `email.clicked` → Analytics Service (engagement metrics)
- `email.campaign_completed` → Campaign Service (signals send job finished; triggers analytics aggregation)
- `email.failed` → Datadog alert via dead-letter monitoring

### 5.3 Bounce Handling

| SendGrid Event | Classification | Email Service Action |
|---|---|---|
| `bounce` with `type = "bounce"` | Hard (permanent) | Status → `bounced`, `bounced_at` set, publish `email.bounced { bounce_type: "hard" }`. Does not affect job `failed_count` — post-delivery bounce is engagement data, not a delivery failure. |
| `bounce` with `type = "blocked"` | Blocked (temporary) | No status change, no event published. Treated as temporary suppression — may resolve on retry. |
| `deferred` | Soft (temporary) | No status change, no event published — SendGrid retries automatically |
| `spamreport` | Spam | Campaign recipient: status → `spam_reported`, publish `email.spam_reported`. Transactional send: status → `bounced`, `bounced_at` set, publish `email.spam_reported`. Neither increments job `failed_count`. |

Hard bounces are not retried. SendGrid automatically suppresses the address; future sends to that address are rejected by SendGrid with a 400.

---

## 6. Fault Handling & Idempotency

### Transactional Send

| Scenario | Behaviour |
|---|---|
| Duplicate `dedup_key` | UNIQUE constraint — return existing row with `200`, no re-send |
| SendGrid transient error (5xx, timeout) | BullMQ retry: 5s → 30s → 2m → 10m; `attempt` incremented |
| SendGrid permanent error (4xx) | No retry. Status → `failed`, `error` populated, publish `email.failed` |
| Worker crash mid-send | Job not ACKed — re-queued on restart. At start of each worker execution, re-fetch the `email_sends` row: if `sendgrid_message_id IS NOT NULL` (SendGrid already accepted), skip the SendGrid call and proceed to publishing `email.sent` using the existing `sendgrid_message_id`. This guards against double-send when the worker crashes after calling SendGrid but before updating the DB row. |
| `location_id` has no configured or verified domain | `422` before enqueue — no BullMQ job created |

### Campaign Send

| Scenario | Behaviour |
|---|---|
| Duplicate `job_ref` | UNIQUE constraint — return existing job with current status in `200`, no re-processing |
| Spam check fails | Job row inserted (status: `spam_check_failed`), `422` returned. No recipients inserted, no BullMQ jobs enqueued. Subsequent calls with same `job_ref` return the `spam_check_failed` job |
| Worker crash mid-campaign | On worker process startup: scan `email_campaign_jobs WHERE status = 'processing'`; for each job, re-enqueue all `email_campaign_recipients WHERE job_id = ? AND status = 'pending'`. This startup recovery hook runs before the worker begins processing new jobs. At the start of each Campaign Recipient Worker job execution, re-fetch the recipient row: if `status != 'pending'` (already processed), skip all processing and return without calling SendGrid or updating counts. This guards against double-send when the worker crashes after calling SendGrid but before updating the recipient row. |
| Individual recipient send fails | Recipient status → `failed`, `failed_count` atomically incremented (`UPDATE ... SET failed_count = failed_count + 1`). Other recipients continue unaffected |
| Template Service 5xx / timeout | BullMQ retry for that recipient (transient). Parent job remains `processing` |
| Template Service 4xx (e.g. template not found) | Permanent failure — no retry. Recipient status → `failed`, `failed_count` incremented |
| All recipients fail | Job status → `failed`, `email.campaign_completed` published |
| Some recipients sent, some failed | Job status → `completed_with_errors`, `email.campaign_completed` published |
| All recipients sent | Job status → `completed`, `email.campaign_completed` published |
| Scheduled job cancelled | Status → `cancelled`. Only allowed in `pending` or `spam_check_failed` states. `409` if job is `processing` or in any terminal state. Once `processing` begins, the job cannot be cancelled — in-flight workers will run to completion |

**Atomic `sent_count`/`failed_count` increment:** Workers always use `UPDATE email_campaign_jobs SET sent_count = sent_count + 1 WHERE id = ?` (or `failed_count`). Never a read-modify-write.

**Atomic completion detection:** After incrementing, the worker attempts:
```sql
UPDATE email_campaign_jobs
SET status = '<terminal_status>', completed_at = now()
WHERE id = ?
  AND sent_count + failed_count = total_recipients
  AND status = 'processing'
RETURNING id
```
Only the worker that receives a row back proceeds to publish `email.campaign_completed`. Concurrent workers that increment simultaneously will each attempt this UPDATE; at most one will match the `AND status = 'processing'` guard.

### Webhook Idempotency

SendGrid delivers webhooks at-least-once. Status updates use a **forward-only WHERE guard**: each UPDATE only advances the recipient to a higher-stage status, preventing a late duplicate from overwriting a more advanced state.

```sql
-- delivered: only advances from 'sent'
UPDATE email_campaign_recipients
SET status = 'delivered', delivered_at = $ts
WHERE id = ? AND status = 'sent'

-- opened: only advances from sent/delivered; preserve first opened_at
UPDATE email_campaign_recipients
SET status = 'opened', opened_at = COALESCE(opened_at, $ts)
WHERE id = ? AND status IN ('sent', 'delivered')

-- clicked: only advances from sent/delivered/opened; preserve first clicked_at
UPDATE email_campaign_recipients
SET status = 'clicked', clicked_at = COALESCE(clicked_at, $ts)
WHERE id = ? AND status IN ('sent', 'delivered', 'opened')
```

A duplicate webhook that matches no rows (status already advanced past the guard) is a no-op — no error, no double-write. The same forward-only pattern applies to `email_sends` rows. Click events are always inserted (multiple clicks tracked individually in `email_recipient_clicks`).

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
│   │   └── campaign-recipient.worker.ts   # BullMQ worker + startup recovery hook
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
- `domain-resolver.ts` — cache hit returns cached domain; cache miss queries DB; missing `location_id` throws; unverified domain throws; cache TTL expiry triggers re-fetch
- `webhook-processor.ts` — all SendGrid event types (`delivered`, `open`, `click`, `bounce`, `unsubscribe`, `spamreport`) route to correct handler; campaign vs. transactional source resolution; unknown event type logged and ignored without throwing
- Dedup key logic — duplicate `dedup_key` returns existing row without enqueue

### Integration Tests (Vitest + real Postgres + real Redis, SendGrid mocked via HTTP interceptor)

- **Transactional happy path** — send queued, worker calls SendGrid, row updated to `sent`, `email.sent` published
- **Duplicate `dedup_key`** — second call returns same `email_id`, SendGrid called exactly once
- **Transient SendGrid failure** — worker retries, `attempt` increments, eventual success
- **Max retries exceeded** — status → `failed`, `email.failed` published to EventBridge
- **Unverified domain** — `POST /emails/send` returns `422` before any DB write
- **Campaign happy path** — 3 recipients: all rendered via Template Service, all sent, job → `completed`, `email.campaign_completed` published
- **Campaign partial failure** — one recipient fails permanently, others succeed → `completed_with_errors`, `failed_count = 1`, `email.campaign_completed` published
- **Campaign crash recovery** — insert `processing` job + `pending` recipients with no BullMQ jobs; simulate worker restart; assert startup hook re-enqueues pending recipients and job completes
- **Spam check gate** — campaign with high-scoring email: `email_campaign_jobs` row inserted with `spam_check_failed` status, `422` returned, no recipients inserted; duplicate `job_ref` returns `200` with `spam_check_failed` status
- **Duplicate `job_ref`** — second call returns existing job, no recipients re-inserted
- **`sent_count` concurrency** — 10 concurrent recipient workers complete simultaneously; assert `sent_count = 10` and `email.campaign_completed` published exactly once
- **Webhook: `delivered` for campaign recipient** — updates `delivered_at`, publishes `email.delivered`
- **Webhook: `delivered` for transactional send** — updates `delivered_at` on `email_sends`, publishes `email.delivered`
- **Webhook: `bounce`** — updates status → `bounced`, publishes `email.bounced { bounce_type: "hard" }`
- **Webhook: `open` for campaign recipient** — updates `opened_at`, publishes `email.opened`
- **Webhook: `open` for transactional send** — status unchanged, no `opened_at` column written, `email.opened` published (no campaign_job_id in payload)
- **Webhook: `click` for campaign recipient** — inserts `email_recipient_clicks` row, updates `clicked_at` on first click only; second click inserts second row, does not update `clicked_at`
- **Webhook: `click` for transactional send** — status unchanged, no `email_recipient_clicks` row inserted, `email.clicked` published
- **Webhook idempotency** — duplicate `delivered` event is a no-op (no duplicate EventBridge publish)
- **Webhook: unknown event type** — logged, ignored, returns `200`

### Contract Tests

**Outbound:**
- `POST /templates/render` — payload shape (template_id, context) matches Template Service API
- EventBridge event shapes for all 9 event types validated against `@ortho/event-bus` schema

**Inbound:**
- SendGrid webhook payload parsing for all handled event types
- ECDSA signature verification rejects tampered payloads

*Test tooling: `@ortho/testing` package — DB fixtures, Redis fixtures, EventBridge mock, HTTP factory stubs.*

---

## 9. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transactional API shape | Callers pass pre-rendered HTML + subject | Consistent with Messaging Service pattern. Email Service stays thin for single sends. Automation Engine and Nurturing Engine call Template Service themselves before calling `POST /emails/send`. |
| Bulk send approach | Job-orchestrated with per-recipient tracking | Enables resumable jobs, per-recipient analytics, and accurate campaign stats independent of webhook timing. |
| Template rendering for bulk | Email Service calls Template Service per recipient during job processing | Avoids large pre-rendered payload from caller. Single rendering path inside the async worker. |
| Unsubscribe storage | No local suppression table — publish `email.unsubscribed`, Lead Service owns opt-out state | Keeps Email Service stateless about entity opt-out. Callers responsible for passing clean recipient lists. |
| Sending domains | Single SendGrid account, per-location authenticated domains in `email_sending_domains` | 34 locations do not warrant SendGrid subuser overhead. Per-domain authentication still provides deliverability isolation. |
| `is_verified` cache | Local column cached; synced on `GET /emails/domains/:id`; pre-send checks read local column | Avoids live SendGrid API call on every send. Operators explicitly sync by hitting the GET endpoint after DNS propagation. |
| Webhook integration | Email Service is single SendGrid contact point (outbound + inbound) | All consumers receive normalized EventBridge events — no direct SendGrid dependency outside this service. |
| Spam check | Sync endpoint + automatic gate on campaign send; job row inserted before gate check | UI gets real-time feedback during drafting; automatic gate prevents high-scoring campaigns from executing. Inserting the job row before the gate enables idempotency for `spam_check_failed` re-submissions. |
| Active hours | Not enforced by Email Service | Callers (Campaign Service `scheduled_for`, Automation/Nurturing Engine) handle timing. Email Service is a delivery primitive. |
| Bounce handling | Hard bounce → status `bounced` + EventBridge event. Soft bounce deferred to SendGrid retry. | Hard bounces are permanent — Lead Service notified via event. Soft bounces resolve at the delivery layer. |
| BullMQ retry | 5s → 30s → 2m → 10m, per send/per recipient | Per-recipient retry prevents one bad address from blocking a campaign. Consistent with Automation Engine retry pattern. |
| `sent_count`/`failed_count` scoping | Both counters incremented by Campaign Recipient Worker only (SendGrid acceptance/rejection). Webhook handler never touches them. | Keeps the completion sum (`sent_count + failed_count = total_recipients`) stable after the campaign completes — post-delivery bounces don't reopen completion logic. Prevents double-counting from duplicate webhooks. |
| Open/click tracking scope | Campaign recipients: full tracking. Transactional sends: EventBridge event published only, no status update, no click table | Engagement analytics are a campaign feature. Transactional callers can subscribe to EventBridge events directly if needed. |
| Spam report status | `spam_reported` as distinct status on `email_campaign_recipients`; `bounced` on `email_sends` | Keeps suppression reasons distinguishable in per-recipient queries. Transactional sends have fewer status values (no `spam_reported`). |
| Job cancellation | Only in `pending` or `spam_check_failed` states | Avoids race with in-flight workers updating counts on a cancelled job. Once `processing` begins, the job runs to completion. |
| Template Service errors | 4xx = permanent failure (no retry); 5xx/timeout = transient (BullMQ retry) | A missing template is a configuration error — retrying will not help. Network errors are transient. |
| Crash recovery | Worker startup hook scans `processing` jobs for `pending` recipients and re-enqueues | Guarantees campaign completion after any ECS task restart. No manual intervention needed. |
