# Email Service — Updated Design Spec

**Date:** 2026-03-29
**Status:** Approved
**Scope:** Platform-layer Email Service — transactional and bulk email delivery via SendGrid, per-recipient campaign tracking, bounce/engagement webhook processing, sending domain management
**Supersedes:** `2026-03-25-email-service-design.md`
**Changes:** Incorporates all 15 clarification answers from `tasks/prd-email-service.md`

---

## Change Summary (vs. 2026-03-25)

| Q# | Change |
|---|---|
| Q1 | Campaign send hard cap: 10,000 recipients per call; 422 if exceeded |
| Q2 | `subject_template` rendered inline by Email Service from recipient `context` (no Template Service call for subjects) |
| Q3 | Plain text not required for campaign sends — SendGrid handles HTML-only |
| Q4 | Opt-out filtering is caller responsibility (Campaign Service pre-filters before calling) |
| Q5 | Single `location_id` per campaign send — multi-location campaigns split by caller |
| Q6 | Cancellation sets DB status only; BullMQ delayed jobs not actively removed; worker guard enforces skip |
| Q7 | `email.bounced` uses `to_address` intentionally (all other events use `to_email`) |
| Q8 | `created_by` populated from authenticated user ID in the JWT passed by Campaign Service |
| Q9 | In-memory domain cache staleness (up to 60s across ECS tasks) accepted |
| Q10 | SendGrid suppression 400 on campaign recipient → treat as bounce (`bounced` status, `email.bounced` event) |
| Q11 | `/webhooks/sendgrid` hosted behind API Gateway with SendGrid-specific routing rule |
| Q12 | `GET /emails/campaigns/:jobId/recipients` uses fixed page size of 100 (not configurable) |
| Q13 | Datadog dashboard (queue depth, send rate, webhook lag, spam failure rate) is part of this spec |
| Q14 | Transactional open/click events written to DB (in addition to EventBridge); `email_send_clicks` table added |
| Q15 | Spam score threshold is per-location, stored in `email_sending_domains.spam_score_threshold` |

---

## 1. Overview

The Email Service is a **platform-layer service** (`apps/platform/email`) responsible for all email delivery via SendGrid. It is fully generic — it has no knowledge of Ortho CRM concepts such as leads, pipeline stages, or coordinators.

**Core responsibilities:**
- Send transactional emails immediately (single recipient, pre-rendered HTML)
- Accept bulk campaign send jobs and process them asynchronously with per-recipient tracking
- Process SendGrid delivery and engagement webhooks; publish normalized events to EventBridge
- Manage per-location SendGrid sending domain configuration (including per-location spam score threshold)
- Expose a spam score check endpoint (used by Campaign builder UI and as an automatic gate on bulk sends)

**Out of scope:**
- Template storage and rendering for transactional sends — callers (Automation Engine, Nurturing Engine) must call `POST /templates/render` on the Template Service themselves and pass the rendered HTML to `POST /emails/send`. The Email Service does not accept `template_id` on `POST /emails/send`. **Note:** the Automation Engine spec's `send_email` action params (`template_id` + `context`) reflect the Automation Engine worker's responsibility to call Template Service before calling this endpoint — the Automation Engine spec must be updated to document this two-step flow.
- Active hours enforcement (callers handle timing before calling this service)
- Unsubscribe list storage (Email Service publishes `email.unsubscribed`; Lead Service owns opt-out state)
- Opt-out filtering — callers are responsible for passing clean recipient lists; Campaign Service must query Lead Service for unsubscribed leads before calling `POST /emails/campaigns/send`
- SendGrid Marketing Campaigns API (all bulk delivery is managed directly via `/v3/mail/send`)

---

## 2. Architecture

```
Callers: Automation Engine, Nurturing Engine, Reporting Service
        │  POST /emails/send (pre-rendered HTML + subject)
        │  (callers render via Template Service before calling)
        │
Campaign Service
        │  POST /emails/campaigns/send (template_id + recipient list)
        │  (Campaign Service pre-filters opt-out recipients before calling)
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
│  ├── DELETE /emails/campaigns/:jobId                     │
│  ├── POST /emails/domains                                │
│  ├── GET  /emails/domains                                │
│  ├── GET  /emails/domains/:id                            │
│  ├── DELETE /emails/domains/:id                          │
│  └── POST /webhooks/sendgrid  ← behind API Gateway      │
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
- **Webhook endpoint isolated behind API Gateway** — `POST /webhooks/sendgrid` is served via a dedicated API Gateway routing rule for SendGrid IPs/routing, separate from the service's main REST API.

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
  "location_id": "loc_123",            // single location_id — multi-location campaigns must be split by caller
  "entity_type": "campaign",           // optional — passed through to EventBridge engagement events
  "entity_id": "campaign-uuid",        // optional — the Campaign Service campaign ID
  "template_id": "post-exam-email",
  "subject_template": "{{first_name}}, your treatment plan is ready",  // inline {{var}} substitution per recipient
  "recipients": [
    { "email": "jane@example.com", "context": { "first_name": "Jane", ... } },
    ...
  ],
  "scheduled_for": "2026-03-26T10:00:00Z"  // optional — null = send immediately
}

→ 202 { "job_id": "uuid", "status": "pending", "total_recipients": 5000 }
→ 200 { "job_id": "uuid", "status": "<current_status>" }  // duplicate job_ref — idempotent, returns current job state
→ 422 { "error": "recipient_limit_exceeded", "limit": 10000, "provided": 12000 }
→ 422 { "error": "spam_check_failed", "job_id": "uuid", "score": 8.2, "threshold": 5.0, "issues": [...] }
→ 422 { "error": "domain_not_configured", "location_id": "loc_123" }
→ 422 { "error": "domain_not_verified", "location_id": "loc_123" }
```

**Caller responsibilities (enforced outside this service):**
- **Opt-out filtering:** Campaign Service must filter unsubscribed recipients by querying Lead Service before calling this endpoint. Email Service trusts the recipient list to be clean.
- **Multi-location splits:** This endpoint accepts a single `location_id`. If a campaign targets recipients across multiple locations (each with a different sending domain), Campaign Service must split the send into one `POST /emails/campaigns/send` call per location.
- **Recipient list size:** Maximum 10,000 recipients per call. Callers with larger audiences must split into multiple calls and coordinate sequencing themselves.

**`subject_template` rendering:** The Email Service performs inline `{{var}}` substitution on `subject_template` per recipient using that recipient's `context` object. This is not routed through the Template Service — it is a simple variable replacement at send time.

**Plain text:** Not required for campaign sends. SendGrid handles HTML-only emails. (Plain text IS required for transactional `POST /emails/send`.)

Flow:
1. Resolve sending domain by `location_id` — fail fast with `422` if not configured or `is_verified = false`
2. Check `job_ref` uniqueness — return existing job with current status if already present
3. Validate recipient count ≤ 10,000 — fail with `422 { "error": "recipient_limit_exceeded" }` if exceeded. No job row inserted.
4. Insert `email_campaign_jobs` row (status: `pending`, `created_by` from JWT user ID)
5. Render one sample recipient via Template Service for spam check:
   - Template Service 4xx (e.g. template not found): update job status → `failed`, return `422 { "error": "template_render_failed", "job_id": "..." }`. No recipients inserted, no BullMQ jobs enqueued.
   - Template Service 5xx / timeout: update job status → `failed`, return `503 { "error": "template_service_unavailable", "job_id": "..." }`. Caller may retry with a new `job_ref`.
6. Run spam check on the rendered sample using the domain's `spam_score_threshold`:
   - If score exceeds threshold: update job status → `spam_check_failed`, store `spam_score` + `spam_issues`, return `422`. No recipients inserted, no BullMQ jobs enqueued.
   - If passes: store `spam_score` + `spam_issues` on job row, continue.
7. Bulk-insert `email_campaign_recipients` (all status: `pending`), update `total_recipients` on job row
8. Update job status → `processing`, set `started_at`
9. Enqueue BullMQ campaign-recipient jobs (one per recipient) with delay if `scheduled_for` is in the future
10. Campaign Recipient Worker per recipient: render template via Template Service → substitute `subject_template` with recipient context → call SendGrid → update recipient row status → atomically increment `sent_count` on parent job using `UPDATE ... SET sent_count = sent_count + 1 WHERE id = ?`. On permanent failure: increment `failed_count` instead.
11. After each increment: check job completion atomically (see Section 6)

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
→ { "recipients": [...], "total": 47, "page": 1, "page_size": 100 }
// Page size is fixed at 100 — not configurable by callers

DELETE /emails/campaigns/:jobId
→ 200   // cancels job in pending or spam_check_failed state — sets status → cancelled
→ 409   // cannot cancel a job in processing or any terminal state (completed, completed_with_errors, failed, cancelled)
```

**Cancellation mechanics:** `DELETE /emails/campaigns/:jobId` sets the DB row `status = 'cancelled'` only. BullMQ delayed jobs (enqueued with `scheduled_for` delay) are **not** actively removed from the queue. The Campaign Recipient Worker checks `status != 'pending'` on the recipient row at the start of each execution — this guard ensures cancelled jobs are skipped when the delayed job eventually fires.

### 3.3 Spam Check

```
POST /emails/spam-check
{
  "location_id": "loc_123",    // optional — if provided, threshold is read from domain's spam_score_threshold
  "subject": "Limited time offer — free exam",
  "html": "<html>...</html>",
  "text": "..."
}

→ 200 {
    "score": 3.1,
    "threshold": 5.0,           // reflects domain threshold if location_id provided, else env var default
    "passed": true,
    "issues": [
      { "rule": "HTML_IMAGE_ONLY", "description": "Message is image-only", "score": 1.2 }
    ]
  }
```

Uses SpamScanner (Node-native npm package — no external service dependency). Called by the Campaign builder UI on demand and automatically at the start of `POST /emails/campaigns/send`.

**Threshold resolution:** If `location_id` is provided, the threshold is read from `email_sending_domains.spam_score_threshold` for that location. If no `location_id` is provided (e.g. ad-hoc checks from the UI before selecting a location), the global environment variable threshold is used (default: 5.0). The automatic campaign send gate always uses the domain's per-location threshold.

### 3.4 Sending Domains

```
POST /emails/domains
{
  "location_id": "loc_123",
  "domain": "mail.drortho.com",
  "from_name": "Dr. Ortho",
  "from_email": "hello@mail.drortho.com",
  "spam_score_threshold": 4.0   // optional — defaults to env var value (5.0) if not provided
}
→ 201 { "id": "uuid", "is_verified": false, "spam_score_threshold": 4.0 }

GET  /emails/domains          → list all domains with local is_verified status and threshold
GET  /emails/domains/:id      → fetch live verification status from SendGrid, update local is_verified, return result
DELETE /emails/domains/:id    → 409 if domain has sent emails in last 30 days
```

**Verification lifecycle:** `is_verified` in `email_sending_domains` is a local cache of the SendGrid domain authentication status. It starts as `false` on creation. It is updated to `true` when `GET /emails/domains/:id` confirms verification from SendGrid. Pre-send checks (`POST /emails/send`, `POST /emails/campaigns/send`) read the local `is_verified` column — no live SendGrid API call at send time.

**Domain resolver cache:** `domain-resolver.ts` maintains an in-memory LRU cache with a 60s TTL. In a multi-ECS-task deployment each task has its own cache, so a newly verified domain (`is_verified` flipped to `true`) may be stale for up to 60s on some tasks. This window is acceptable — operators are aware that sends may briefly be rejected immediately after DNS verification.

---

## 4. Database Schema — `platform_email`

```sql
-- Per-location sending domain configuration
email_sending_domains (
  id                    uuid PRIMARY KEY,
  location_id           text NOT NULL UNIQUE,
  domain                text NOT NULL,
  from_name             text NOT NULL,
  from_email            text NOT NULL,           -- e.g. hello@mail.drortho.com
  is_verified           boolean NOT NULL DEFAULT false,
  spam_score_threshold  numeric NOT NULL DEFAULT 5.0,  -- per-location spam gate (Q15)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
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
    -- queued | sent | delivered | opened | clicked | bounced | unsubscribed | failed
  attempt              integer NOT NULL DEFAULT 0,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  opened_at            timestamptz,          -- set on first open webhook (Q14)
  clicked_at           timestamptz,          -- set on first click webhook (Q14)
  bounced_at           timestamptz
)

-- Per-click tracking for transactional sends (Q14)
email_send_clicks (
  id          uuid PRIMARY KEY,
  send_id     uuid REFERENCES email_sends NOT NULL,
  url         text NOT NULL,
  clicked_at  timestamptz NOT NULL DEFAULT now()
)

-- Campaign bulk send jobs
email_campaign_jobs (
  id                uuid PRIMARY KEY,
  job_ref           text UNIQUE,           -- caller idempotency key
  location_id       text NOT NULL,
  entity_type       text,                  -- optional correlation field from caller (e.g. "campaign")
  entity_id         text,                  -- optional correlation field from caller (e.g. Campaign Service campaign ID)
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
  created_by        text,                  -- authenticated user ID from JWT (Q8)
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
CREATE INDEX ON email_sends (domain_id, created_at);
CREATE INDEX ON email_send_clicks (send_id);
CREATE INDEX ON email_campaign_jobs (status);
CREATE INDEX ON email_campaign_jobs (location_id);
CREATE INDEX ON email_campaign_jobs (domain_id, created_at);
CREATE INDEX ON email_campaign_recipients (job_id, status);
CREATE INDEX ON email_campaign_recipients (sendgrid_message_id);
CREATE INDEX ON email_recipient_clicks (recipient_id);
```

**Schema notes:**
- `email_sending_domains.spam_score_threshold` — per-location gate; used by `POST /emails/campaigns/send` and `POST /emails/spam-check` when `location_id` is provided
- `email_sends.opened_at`, `.clicked_at` — tracked for transactional sends as of Q14; status advances to `opened`/`clicked`
- `email_send_clicks` — per-click row for transactional sends; mirrors `email_recipient_clicks` for campaign recipients
- `email_campaign_jobs.created_by` — populated from the authenticated user ID extracted from the JWT in the incoming request; Campaign Service must forward the user's identity token
- `email_sends.sendgrid_message_id` — indexed for fast webhook correlation
- `email_sends (status)` — supports monitoring queries (e.g. find all `queued` sends on restart)
- `email_sends (domain_id, created_at)` and `email_campaign_jobs (domain_id, created_at)` — support the domain deletion 30-day check across both tables
- `email_campaign_jobs (status)` — supports crash-recovery startup scan (find all `processing` jobs with orphaned `pending` recipients)
- `email_campaign_jobs (location_id)` — supports admin/reporting queries by location
- `email_campaign_recipients (job_id, status)` — supports progress polling, status-filtered queries, and crash-recovery re-enqueue scan
- `email_campaign_recipients.context` — snapshot at insert time; never updated after insert
- No hard deletes — all rows serve as audit log

---

## 5. SendGrid Webhook Handling

SendGrid delivers all engagement events (delivered, open, click, bounce, unsubscribe, spam report) as POST batches to `POST /webhooks/sendgrid`.

**Endpoint security:** `POST /webhooks/sendgrid` is hosted behind API Gateway with a SendGrid-specific routing rule (separate from the service's main API). ECDSA signature verification remains in-service as an additional layer (signing key from AWS Secrets Manager).

### 5.1 Processing Flow

```
SendGrid POST /webhooks/sendgrid
  → API Gateway routing rule (SendGrid-specific)
  → Verify ECDSA signature (signing key from AWS Secrets Manager)
  → Parse event batch (SendGrid sends arrays of events)
  → For each event:
      1. Determine source: look up email_campaign_recipients by sendgrid_message_id first;
         if not found, look up email_sends by sendgrid_message_id
      2. Update row status + timestamp per event type using forward-only WHERE guards (see Section 6):
           delivered        → status = 'delivered', delivered_at = event_timestamp
                              (both email_sends and email_campaign_recipients)
           open             → campaign recipient: status = 'opened', opened_at = event_timestamp
                              transactional send: status = 'opened', opened_at = event_timestamp (Q14)
           click            → campaign recipient: status = 'clicked', clicked_at = event_timestamp (first only)
                              transactional send: status = 'clicked', clicked_at = event_timestamp (first only) (Q14)
           bounce (hard)    → status = 'bounced', bounced_at = event_timestamp
                              (SendGrid event.type = "bounce")
           bounce (blocked) → no status change, no event published — treated as temporary suppression
                              (SendGrid event.type = "blocked")
           deferred         → no status change, no event published — SendGrid retries automatically
           spamreport       → campaign recipient: status = 'spam_reported'
                              transactional send: status = 'bounced', bounced_at = event_timestamp
           unsubscribe      → status = 'unsubscribed'
      3. For click events on campaign recipients: insert email_recipient_clicks row (always — multiple clicks tracked)
         For click events on transactional sends: insert email_send_clicks row (always — multiple clicks tracked) (Q14)
      4. Publish EventBridge event
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
| `email.opened` | Recipient opens email (pixel) — campaign and transactional | `email_id`, `to_email`, `location_id`, `entity_type?`, `entity_id?`, `campaign_job_id?` |
| `email.clicked` | Recipient clicks a tracked link — campaign and transactional | `email_id`, `to_email`, `url`, `location_id`, `entity_type?`, `entity_id?`, `campaign_job_id?` |
| `email.bounced` | Hard bounce (SendGrid `bounce` event) | `email_id`, `to_address`, `location_id`, `bounce_type: "hard"`, `campaign_job_id?` |
| `email.unsubscribed` | Recipient clicks unsubscribe | `to_email`, `location_id` |
| `email.spam_reported` | Recipient marks as spam | `to_email`, `location_id` |
| `email.failed` | Max retries exceeded (transactional) | `email_id`, `to_email`, `location_id`, `entity_type?`, `entity_id?`, `dedup_key`, `error` |
| `email.campaign_completed` | Campaign job reaches terminal state | `job_id`, `job_ref`, `status`, `total_recipients`, `sent_count`, `failed_count`, `location_id` |

**Note on `to_address` vs. `to_email`:** `email.bounced` uses `to_address` in its payload intentionally — this is a deliberate naming distinction from `to_email` used in all other event types.

**Campaign engagement correlation:** When `entity_type: "campaign"` and `entity_id: "<campaign_id>"` are set on the job (via `POST /emails/campaigns/send`), these values are included in `email.opened` and `email.clicked` events. Analytics Service uses `entity_id` as the campaign dimension for engagement rollups. When `entity_type`/`entity_id` are absent (e.g., transactional sends), the events still publish but without campaign attribution.

**Subscribers:**
- `email.bounced` → Lead Service (flags lead email as undeliverable)
- `email.unsubscribed`, `email.spam_reported` → Lead Service (sets email opt-out flag)
- `email.delivered`, `email.opened`, `email.clicked` → Analytics Service (engagement metrics)
- `email.campaign_completed` → Campaign Service (signals send job finished; triggers analytics aggregation)
- `email.failed` → Datadog alert via dead-letter monitoring

### 5.3 Bounce Handling

| SendGrid Event | Classification | Email Service Action |
|---|---|---|
| `bounce` with `type = "bounce"` | Hard (permanent) | Status → `bounced`, `bounced_at` set, publish `email.bounced { to_address, bounce_type: "hard" }`. Does not affect job `failed_count` — post-delivery bounce is engagement data, not a delivery failure. |
| `bounce` with `type = "blocked"` | Blocked (temporary) | No status change, no event published. Treated as temporary suppression — may resolve on retry. |
| `deferred` | Soft (temporary) | No status change, no event published — SendGrid retries automatically |
| `spamreport` | Spam | Campaign recipient: status → `spam_reported`, publish `email.spam_reported`. Transactional send: status → `bounced`, `bounced_at` set, publish `email.spam_reported`. Neither increments job `failed_count`. |
| SendGrid 400 (suppressed address) | Previously bounced | Campaign Recipient Worker treats this as a bounce: recipient status → `bounced`, publish `email.bounced`. Counts toward `failed_count` (rejected at send time, not post-delivery). |

Hard bounces are not retried. SendGrid automatically suppresses the address; future sends to that address are rejected by SendGrid with a 400 — treated as a bounce by the Campaign Recipient Worker (see above).

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
| Recipient count exceeds 10,000 | `422 { "error": "recipient_limit_exceeded" }` — no job row inserted |
| Spam check fails | Job row inserted (status: `spam_check_failed`), `422` returned. No recipients inserted, no BullMQ jobs enqueued. Subsequent calls with same `job_ref` return the `spam_check_failed` job |
| Worker crash mid-campaign | On worker process startup: scan `email_campaign_jobs WHERE status = 'processing'`; for each job, re-enqueue all `email_campaign_recipients WHERE job_id = ? AND status = 'pending'`. This startup recovery hook runs before the worker begins processing new jobs. At the start of each Campaign Recipient Worker job execution, re-fetch the recipient row: if `status != 'pending'` (already processed), skip all processing and return without calling SendGrid or updating counts. This guards against double-send when the worker crashes after calling SendGrid but before updating the recipient row. |
| Individual recipient send fails | Recipient status → `failed`, `failed_count` atomically incremented. Other recipients continue unaffected |
| SendGrid 400 for suppressed address | Recipient status → `bounced`, `failed_count` incremented, `email.bounced` published (Q10) |
| Template Service 5xx / timeout | BullMQ retry for that recipient (transient). Parent job remains `processing` |
| Template Service 4xx (e.g. template not found) | Permanent failure — no retry. Recipient status → `failed`, `failed_count` incremented |
| All recipients fail | Job status → `failed`, `email.campaign_completed` published |
| Some recipients sent, some failed | Job status → `completed_with_errors`, `email.campaign_completed` published |
| All recipients sent | Job status → `completed`, `email.campaign_completed` published |
| Scheduled job cancelled | Status → `cancelled`. Only allowed in `pending` or `spam_check_failed` states. `409` if job is `processing` or in any terminal state. Once `processing` begins, the job cannot be cancelled — in-flight workers will run to completion. BullMQ delayed jobs are NOT actively removed from the queue; the worker guard (`status != 'pending'` on the recipient row) skips processing when the delayed job fires. |

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

SendGrid delivers webhooks at-least-once. Status updates use a **forward-only WHERE guard**: each UPDATE only advances the recipient/send to a higher-stage status, preventing a late duplicate from overwriting a more advanced state.

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

The same forward-only pattern applies to `email_sends` rows (including the new `opened`/`clicked` states added in Q14). A duplicate webhook that matches no rows (status already advanced past the guard) is a no-op — no error, no double-write. Click events (`email_recipient_clicks`, `email_send_clicks`) are always inserted (multiple clicks tracked individually).

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
│   │   ├── subject-renderer.ts    # inline {{var}} substitution for subject_template
│   │   └── webhook-processor.ts   # parse + route SendGrid webhook events
│   ├── workers/
│   │   ├── transactional-send.worker.ts   # BullMQ worker
│   │   └── campaign-recipient.worker.ts   # BullMQ worker + startup recovery hook
│   ├── repositories/
│   │   ├── sends.repo.ts
│   │   ├── send-clicks.repo.ts
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
- API Gateway — SendGrid-specific routing rule for `POST /webhooks/sendgrid`

---

## 8. Observability

### 8.1 Datadog Dashboard

A Datadog dashboard is part of this spec (Q13). Key metrics:

| Metric | Source | Alert |
|---|---|---|
| BullMQ `transactional-send` queue depth | Redis BullMQ queue size | Alert if depth > 1,000 for > 5 min |
| BullMQ `campaign-recipient` queue depth | Redis BullMQ queue size | Alert if depth > 50,000 for > 10 min |
| Campaign send rate (emails/min) | `sent_count` increments | — |
| Webhook processing lag (time from event timestamp to processing) | Webhook handler timing | Alert if p95 > 30s |
| Spam check failure rate (% of campaign sends blocked) | `spam_check_failed` job count / total jobs | — |
| `email.failed` dead-letter rate | EventBridge dead-letter monitoring | Alert on any `email.failed` event |

### 8.2 Structured Logging

All components use `@ortho/logger` (Pino). Log fields include `location_id`, `job_id`, `email_id`, `sendgrid_message_id`, `attempt` where applicable. Error logs include the full error object.

### 8.3 Health Check

`GET /health` — returns `200 { "status": "ok" }` after verifying DB connectivity and Redis connectivity. Used by ECS task health check.

### 8.4 Graceful Shutdown

On SIGTERM: drain BullMQ workers (wait for in-flight jobs to complete), close DB connection pool, exit. ECS stop timeout should be set to at least 30 seconds to allow in-flight campaign recipient workers to complete their current send.

---

## 9. Testing Strategy

### Unit Tests (Vitest — pure functions, no I/O)

- `spam-scanner.ts` — known spam patterns score above threshold; clean emails pass; threshold boundary cases
- `subject-renderer.ts` — `{{var}}` substitution with present keys; missing keys replaced with empty string; no-op on templates with no vars
- `domain-resolver.ts` — cache hit returns cached domain; cache miss queries DB; missing `location_id` throws; unverified domain throws; cache TTL expiry triggers re-fetch
- `webhook-processor.ts` — all SendGrid event types (`delivered`, `open`, `click`, `bounce`, `unsubscribe`, `spamreport`) route to correct handler; campaign vs. transactional source resolution; `bounce` type `blocked` is no-op; unknown event type logged and ignored without throwing
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
- **Recipient limit exceeded** — 10,001 recipients returns `422 { "error": "recipient_limit_exceeded" }`, no job row inserted
- **Per-location spam threshold** — domain with `spam_score_threshold = 3.0`; email scoring 4.0 fails gate; same email passes on domain with threshold 5.0
- **`sent_count` concurrency** — 10 concurrent recipient workers complete simultaneously; assert `sent_count = 10` and `email.campaign_completed` published exactly once
- **Cancelled scheduled job** — `DELETE /emails/campaigns/:jobId` sets status `cancelled`; assert BullMQ job still exists in queue; when delayed job fires, worker skips all recipients; job remains `cancelled`
- **SendGrid suppression 400** — campaign recipient worker receives 400 from SendGrid; recipient → `bounced`, `failed_count` incremented, `email.bounced` published
- **Webhook: `delivered` for campaign recipient** — updates `delivered_at`, publishes `email.delivered`
- **Webhook: `delivered` for transactional send** — updates `delivered_at` on `email_sends`, publishes `email.delivered`
- **Webhook: `bounce`** — updates status → `bounced`, publishes `email.bounced { bounce_type: "hard" }`
- **Webhook: `open` for campaign recipient** — updates `opened_at`, publishes `email.opened`
- **Webhook: `open` for transactional send** — status → `opened`, `opened_at` set, `email.opened` published (Q14)
- **Webhook: `click` for campaign recipient** — inserts `email_recipient_clicks` row, updates `clicked_at` on first click only; second click inserts second row, does not update `clicked_at`
- **Webhook: `click` for transactional send** — inserts `email_send_clicks` row, status → `clicked`, `clicked_at` set on first click; second click inserts row, does not update `clicked_at` (Q14)
- **Webhook idempotency** — duplicate `delivered` event is a no-op (no duplicate EventBridge publish)
- **Webhook: unknown event type** — logged, ignored, returns `200`
- **Webhook: `bounce` type `blocked`** — no status change, no event published, returns `200`

### Contract Tests

**Outbound:**
- `POST /templates/render` — payload shape (template_id, context) matches Template Service API
- EventBridge event shapes for all 9 event types validated against `@ortho/event-bus` schema

**Inbound:**
- SendGrid webhook payload parsing for all handled event types
- ECDSA signature verification rejects tampered payloads

*Test tooling: `@ortho/testing` package — DB fixtures, Redis fixtures, EventBridge mock, HTTP factory stubs.*

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transactional API shape | Callers pass pre-rendered HTML + subject | Consistent with Messaging Service pattern. Email Service stays thin for single sends. Automation Engine and Nurturing Engine call Template Service themselves before calling `POST /emails/send`. |
| Bulk send approach | Job-orchestrated with per-recipient tracking | Enables resumable jobs, per-recipient analytics, and accurate campaign stats independent of webhook timing. |
| Template rendering for bulk | Email Service calls Template Service per recipient during job processing | Avoids large pre-rendered payload from caller. Single rendering path inside the async worker. |
| Subject template rendering | Email Service does inline `{{var}}` substitution from recipient `context` | Subjects are simple variable substitutions — routing through Template Service would be overhead with no benefit. |
| Recipient cap | 10,000 per call, callers split | Protects against oversized request bodies and unbounded bulk inserts. Callers (Campaign Service) are better positioned to chunk and sequence large sends. |
| Unsubscribe + opt-out storage | No local suppression table — publish `email.unsubscribed`, Lead Service owns opt-out state; callers pre-filter | Keeps Email Service stateless about entity opt-out. Campaign Service queries Lead Service before calling. |
| Spam threshold | Per-location in `email_sending_domains.spam_score_threshold` | Different locations may have different content requirements. Promotional thresholds can be tighter than transactional. |
| Sending domains | Single SendGrid account, per-location authenticated domains in `email_sending_domains` | 34 locations do not warrant SendGrid subuser overhead. Per-domain authentication still provides deliverability isolation. |
| `is_verified` cache | Local column cached; synced on `GET /emails/domains/:id`; pre-send checks read local column; 60s in-memory per-ECS-task cache acceptable | Avoids live SendGrid API call on every send. Up to 60s cross-task staleness is acceptable after new domain verification. |
| Webhook integration | Email Service is single SendGrid contact point (outbound + inbound); behind API Gateway with SendGrid-specific rule | All consumers receive normalized EventBridge events. API Gateway routing provides additional SendGrid IP-level control beyond ECDSA verification. |
| Spam check | Sync endpoint + automatic gate on campaign send; job row inserted before gate check | UI gets real-time feedback during drafting; automatic gate prevents high-scoring campaigns from executing. Inserting the job row before the gate enables idempotency for `spam_check_failed` re-submissions. |
| Open/click tracking scope | Campaign recipients AND transactional sends: full tracking (EventBridge + DB write + click table) | Consistent engagement data model. Transactional callers (e.g. Reporting Service) can query click data for sent emails. |
| Cancellation mechanics | DB status only; BullMQ delayed jobs not actively removed; worker guard enforces skip | Avoids race between cancellation and delayed job fire. Worker guard is reliable because it reads authoritative DB state at execution time. |
| Active hours | Not enforced by Email Service | Callers (Campaign Service `scheduled_for`, Automation/Nurturing Engine) handle timing. Email Service is a delivery primitive. |
| Bounce handling | Hard bounce → status `bounced` + EventBridge event. SendGrid suppression 400 → treated as bounce by worker. Soft bounce deferred to SendGrid retry. | Hard bounces are permanent — Lead Service notified via event. Suppression 400s represent the same outcome. Soft bounces resolve at the delivery layer. |
| BullMQ retry | 5s → 30s → 2m → 10m, per send/per recipient | Per-recipient retry prevents one bad address from blocking a campaign. Consistent with Automation Engine retry pattern. |
| `sent_count`/`failed_count` scoping | Both counters incremented by Campaign Recipient Worker only (SendGrid acceptance/rejection). Webhook handler never touches them. | Keeps the completion sum (`sent_count + failed_count = total_recipients`) stable after the campaign completes — post-delivery bounces don't reopen completion logic. Prevents double-counting from duplicate webhooks. |
| Spam report status | `spam_reported` as distinct status on `email_campaign_recipients`; `bounced` on `email_sends` | Keeps suppression reasons distinguishable in per-recipient queries. Transactional sends have fewer status values (no `spam_reported`). |
| Job cancellation scope | Only in `pending` or `spam_check_failed` states | Avoids race with in-flight workers updating counts on a cancelled job. Once `processing` begins, the job runs to completion. |
| Template Service errors | 4xx = permanent failure (no retry); 5xx/timeout = transient (BullMQ retry) | A missing template is a configuration error — retrying will not help. Network errors are transient. |
| Crash recovery | Worker startup hook scans `processing` jobs for `pending` recipients and re-enqueues | Guarantees campaign completion after any ECS task restart. No manual intervention needed. |
