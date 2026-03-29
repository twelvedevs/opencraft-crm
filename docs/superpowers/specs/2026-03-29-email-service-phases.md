# Email Service — Implementation Phases

## Phase 1: Foundation & Domain Management

- Fastify app skeleton, TypeScript config, env validation
- DB migrations — all 4 tables (`email_sending_domains`, `email_sends`, `email_campaign_jobs`, `email_campaign_recipients`, `email_recipient_clicks`) + indexes
- Domain management API (`POST/GET/DELETE /emails/domains`) with domain resolver + 60s in-memory cache
- Per-location spam score threshold on `email_sending_domains` (Q15 answer)
- `@ortho/event-bus` wired up (no events published yet)

## Phase 2: Transactional Send

- `POST /emails/send` — domain check, dedup via `dedup_key`, enqueue BullMQ job
- Transactional Send Worker — SendGrid `/v3/mail/send`, exponential backoff (5s → 30s → 2m → 10m)
- Crash recovery guard (skip if `sendgrid_message_id` already set)
- Publish `email.sent` and `email.failed` events

## Phase 3: Spam Check + Campaign Send

- `POST /emails/spam-check` — SpamScanner with per-location threshold
- `POST /emails/campaigns/send` — domain check, idempotency, spam gate, bulk recipient insert, BullMQ enqueue with optional `scheduled_for` delay
- `GET /emails/campaigns/:jobId`, `GET /emails/campaigns/:jobId/recipients` (fixed page size 100), `DELETE /emails/campaigns/:jobId`
- Campaign Recipient Worker — Template Service call per recipient, SendGrid send, atomic `sent_count`/`failed_count`, atomic completion detection
- Startup crash recovery scan — re-enqueue `pending` recipients for `processing` jobs
- Publish `email.campaign_completed`

## Phase 4: Webhook Processing

- `POST /webhooks/sendgrid` behind API Gateway (Q11)
- ECDSA signature verification via AWS Secrets Manager signing key
- Event routing with forward-only `WHERE` guards for all event types
- Write open/click events to DB for transactional sends (Q14 answer)
- `email_recipient_clicks` inserts for campaign recipients
- Publish all engagement events: `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.unsubscribed`, `email.spam_reported`
- Bounce handling — treat SendGrid suppression 400 responses as `bounced` (Q10 answer)

## Phase 5: Observability & Hardening

- Structured logging via `@ortho/logger` (Pino/Datadog)
- Datadog dashboard — BullMQ queue depth, campaign send rate, webhook processing lag, spam check failure rate (Q13 answer)
- Health check endpoint
- SIGTERM graceful shutdown (drain BullMQ workers, close DB pool)
- API Gateway rule for SendGrid webhook IP/routing

---

Phases 1–3 deliver the full send path.
Phase 4 closes the feedback loop (engagement + opt-out events).
Phase 5 is operational readiness.
