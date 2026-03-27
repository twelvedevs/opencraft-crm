# Automation Engine — Implementation Phases


Phase 1 — Schema & Rule Management API
- DB schema + migrations (platform_automation schema, all 4 tables)
- Rule CRUD: create, read, update, soft-delete
- Rule versioning: insert new version on edit, activate version, disable rule
- Rule validation at save time: branch nesting hard cap (3 levels), required field checks
- GET /rules, GET /rules/:id, POST /rules, PUT /rules/:id/versions/:v/activate, DELETE /rules/:id

Phase 2 — Evaluation Core (pure functions)
- Field Interpolator (dot-notation + template strings)
- Condition Evaluator (all operators, nested AND/OR/NOT)
- Active Hours Calculator (delay-until, DST edge cases)
- Full unit test coverage for all three

Phase 3 — Event Consumer + Rule Matching
- SQS poller + EventBridge event schema validation
- Rule Matcher with in-memory cache (TTL from ENV, default 30s)
- Wires Phase 2 evaluators together: match → evaluate conditions → hand off to Execution Manager

Phase 4 — Execution Manager + Flow Workers
- Execution Manager: idempotency check, insert execution + all steps (full tree pre-insert), enqueue root job
- branch worker: condition eval → enqueue winning path, mark losing path skipped
- enroll_sequence worker → POST /sequences/enroll
- emit_event worker → EventBridge publish
- BullMQ retry semantics (exponential backoff, dead-letter, Datadog alert on DLQ)

Phase 5 — Messaging Workers
- send_message worker: Template Service render → Messaging Service send, active hours gating
- send_email worker: Template Service render → Email Service send, active hours gating
- Disabled-rule job cancellation for delayed BullMQ jobs

Phase 6 — AI & Webhook Workers
- call_ai worker: auto_send: false (store in output) + auto_send: true (synthetic send with auto_send_respects_active_hours flag)
- call_webhook worker: timeout → immediate step failure, no retry
- Secret resolution from AWS Secrets Manager

Phase 7 — Execution Log API + Test Endpoint + Retention
- GET /executions (log query, Manager-only)
- GET /executions/:id/steps/:stepId/output
- POST /rules/:id/test dry-run endpoint (full evaluation, no side effects)
- Execution log retention cleanup job (configurable via ENV, 90d default)

---
Each phase produces a runnable, testable slice. Phases 1–2 have no external dependencies; Phases 3–7 build on them sequentially.
