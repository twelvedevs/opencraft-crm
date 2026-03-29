# Clarifying Questions: Email Service

> Original request: Generate clarifying questions for the Email Service design spec at `docs/superpowers/specs/2026-03-25-email-service-design.md`

## Questions

1. **Campaign recipient list size** — `POST /emails/campaigns/send` accepts `recipients` as an inline JSON array. For large campaigns, this could be a very large request body (e.g. 5,000 recipients × context payload). Is there a limit on the array size per request?
   A. No limit — callers are responsible for splitting; Email Service accepts any size
   B. Hard cap (e.g. 10,000 recipients) with a `422` returned if exceeded
   C. The API will accept a streaming/chunked approach (S3 reference, multipart, etc.)
   D. Other: [please specify]

   **Answer:** B

2. **`subject_template` rendering for campaign emails** — The spec shows `"subject_template": "{{first_name}}, your treatment plan is ready"` in the campaign send request. Who renders this per-recipient subject line?
   A. The Email Service does inline substitution from the recipient `context` (not via Template Service)
   B. The Email Service calls Template Service for subject rendering too (separate from HTML rendering)
   C. Template Service returns both HTML and subject together from a single `POST /templates/render` call
   D. Other: [please specify]

   **Answer:** A

3. **Plain text fallback for campaigns** — `POST /emails/send` (transactional) requires a `text` field. `POST /emails/campaigns/send` only specifies `template_id`. Does the Template Service always return a plain text version alongside HTML? If not, how is the plain text fallback handled for bulk sends?
   A. Template Service always returns both `html` and `text` from `POST /templates/render` — Email Service uses both
   B. Template Service returns HTML only; Email Service generates plain text by stripping HTML tags
   C. Plain text is optional for campaigns — SendGrid handles HTML-only emails fine
   D. Other: [please specify]

   **Answer:** C

4. **Opt-out enforcement at send time** — The spec states "callers responsible for passing clean recipient lists" and that Email Service publishes `email.unsubscribed` for Lead Service to own opt-out state. What's the expected flow for a Campaign Service bulk send — does it query Lead Service for opt-outs before calling `POST /emails/campaigns/send`, or is there another mechanism?
   A. Campaign Service queries Lead Service for unsubscribed leads and filters the list before calling Email Service
   B. Email Service checks a suppression list it receives from Lead Service via event-sync (local table)
   C. SendGrid's own suppression list handles it — if an address is unsubscribed, SendGrid silently skips it
   D. Other: [please specify]

   **Answer:** A

5. **Multi-location campaigns** — The `POST /emails/campaigns/send` API accepts a single `location_id`. If Campaign Service needs to send to recipients across multiple locations (each with a different sending domain), is Campaign Service responsible for splitting one campaign into multiple Email Service jobs?
   A. Yes — Campaign Service splits by location and calls `POST /emails/campaigns/send` once per location
   B. Campaigns in this product are always scoped to a single location — multi-location sends don't occur
   C. Email Service will accept multiple `location_id`s and handle domain selection per recipient
   D. Other: [please specify]

   **Answer:** A

6. **BullMQ delayed job cancellation** — When a scheduled job (with `scheduled_for` in the future) is cancelled via `DELETE /emails/campaigns/:jobId`, does the Email Service also remove the BullMQ delayed jobs from the queue? Or does it rely only on the `status != 'pending'` guard in the Campaign Recipient Worker to skip processing?
   A. Only the DB row status is updated to `cancelled`; the worker's guard (`status != 'pending'`) skips processing when the delay fires
   B. Email Service actively removes the BullMQ delayed jobs from the queue on cancellation
   C. A hybrid: attempt BullMQ removal, fall back to the worker guard if removal fails (race condition)
   D. Other: [please specify]

   **Answer:** A

7. **`email.bounced` payload inconsistency** — The EventBridge event table (Section 5.2) shows `to_address` as the field name in `email.bounced`, while all other events use `to_email`. Is `to_address` intentional (different field name for bounce events) or a typo?
   A. Typo — should be `to_email` for consistency with all other events
   B. Intentional — `to_address` is the correct field name for bounce events
   C. Other: [please specify]

   **Answer:** B

8. **`created_by` field on `email_campaign_jobs`** — The schema includes a `created_by` column but the spec doesn't describe what populates it. What is the expected value?
   A. The authenticated user ID (from the JWT calling Campaign Service, forwarded in the request)
   B. The service name of the caller (e.g. `"campaign-service"`)
   C. Unused/reserved for future use — null at this stage
   D. Other: [please specify]

   **Answer:** A

9. **Sending domain cache in multi-instance deployment** — `domain-resolver.ts` uses an in-memory cache with a 60s TTL. In a multi-ECS-task deployment, each task has its own cache. If a domain is newly verified (`is_verified` flipped to `true`), some tasks may serve stale `is_verified = false` for up to 60s. Is this acceptable?
   A. Yes — 60s stale window is acceptable; operators are aware sends may be rejected briefly after verification
   B. The cache should be moved to Redis (shared across ECS tasks) to avoid per-task staleness
   C. Pre-send checks should bypass cache and always read from DB
   D. Other: [please specify]

   **Answer:** A

10. **SendGrid suppression on re-send to bounced address** — The spec states "SendGrid automatically suppresses the address; future sends to that address are rejected by SendGrid with a 400." When a campaign recipient worker calls SendGrid for an address that's already on SendGrid's suppression list, how should the worker handle the 400 response?
    A. Treat it as a permanent failure (`recipient.status = 'failed'`) — no different from other 4xx errors
    B. Treat it as a bounce (`recipient.status = 'bounced'`) and publish `email.bounced` — the address was already known bounced
    C. Email Service should pre-filter suppressed addresses by querying SendGrid's suppression API before enqueuing
    D. Other: [please specify]

    **Answer:** B

11. **Webhook endpoint security** — Beyond ECDSA signature verification, is `POST /webhooks/sendgrid` publicly accessible or should it be restricted (e.g. IP allowlist for SendGrid IPs, VPC-only, API Gateway rule)?
    A. ECDSA verification is sufficient — endpoint is publicly accessible behind the standard load balancer
    B. IP allowlist for known SendGrid webhook IP ranges as an additional layer
    C. Hosted behind API Gateway with a SendGrid-specific rule (separate from the service's main API)
    D. Other: [please specify]

    **Answer:** C

12. **`GET /emails/campaigns/:jobId/recipients` page size** — The endpoint accepts `?status=bounced&page=1` but the spec doesn't specify page size. Is it a fixed size or a configurable query parameter?
    A. Fixed page size (e.g. 100 per page) — not configurable by callers
    B. Configurable via `?limit=` query parameter with a reasonable maximum (e.g. 500)
    C. No pagination needed — always return all matching recipients
    D. Other: [please specify]

    **Answer:** A

13. **Monitoring beyond dead-letter alerts** — The spec mentions `email.failed` triggers a Datadog alert. Are there additional operational metrics expected at launch (e.g. BullMQ queue depth, campaign send rate, webhook processing lag, spam check failure rate)?
    A. `email.failed` dead-letter alert is sufficient for launch — additional dashboards are post-launch
    B. Yes — a Datadog dashboard with key metrics (queue depth, send rate, webhook lag) is part of this spec
    C. Monitoring is owned by the DevOps/infra team separately from this service spec
    D. Other: [please specify]

    **Answer:** B

14. **Transactional send — no open/click tracking** — The spec explicitly excludes open/click tracking for transactional sends (EventBridge event published, but no status update or click table). Should SendGrid click-tracking URL wrapping be disabled for transactional sends, or are clicks still tracked at the SendGrid level (just not persisted locally)?
    A. Click tracking should be disabled in the SendGrid API call for transactional sends (no URL wrapping)
    B. SendGrid click tracking remains enabled; events arrive via webhook and are published to EventBridge, just not written to the DB
    C. Open/click tracking is enabled or disabled at the SendGrid account/domain level — not per-send configurable
    D. Other: [please specify]

    **Answer:** B, can we also write it into DB?

15. **Spam check threshold configurability** — The default threshold is 5.0 via environment variable. Is this a single global threshold, or should it be configurable per location or per campaign type (e.g. more lenient for appointment reminders vs. promotional emails)?
    A. Single global threshold via environment variable — one value for all sends
    B. Per-location threshold stored in `email_sending_domains`
    C. Passed as an optional parameter in `POST /emails/campaigns/send` by the caller
    D. Other: [please specify]

    **Answer:** B
