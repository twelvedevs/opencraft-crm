# Clarifying Questions: Nurturing Engine

> Original request: Generate PRD for the Nurturing Engine based on `docs/superpowers/specs/2026-03-25-nurturing-engine-design.md` — a platform-layer time-delayed drip sequence runtime with enrollment lifecycle, BullMQ-backed step scheduling, A/B testing, unenrollment, opt-out handling, and `@platform/sequence-ui` React component.

## Questions

1. Does `@ortho/interpolator` already exist (built during the Automation Engine iteration), or does it need to be created from scratch in this iteration?
	A. Already exists — import it directly, no changes needed
	B. Already exists but needs the `active-hours` calculator added to it
	C. Does not exist yet — create it fresh in this iteration (both field interpolator + active hours)
	D. Other: [please specify]

	**Answer:** C

2. Is `@platform/sequence-ui` (the React component package) in scope for this Ralph iteration, or is it deferred?
	A. In scope — implement the full Sequence Builder, Enrollment Log, and A/B Results panel
	B. In scope — implement a minimal read-only view only (no builder UI)
	C. Deferred — backend service only in this iteration
	D. Other: [please specify]

	**Answer:** C

3. The `call_ai` action calls `POST /ai/complete`. What parameters should the worker pass?
	A. `{ prompt, model, context }` where `prompt` is a template string from step params
	B. `{ system_prompt, user_prompt, model }` — two-field prompt structure
	C. Pass the full enrollment context + a `prompt_template` field defined in step params; AI Service resolves it
	D. Other: [please specify]

	**Answer:** B

4. The spec says the safety-net poller runs "every 5 minutes as a separate ECS Scheduled Task." For Ralph's implementation, how should this be built?
	A. In-process `setInterval` inside the worker entry point — simpler, no extra ECS task
	B. Separate ECS Scheduled Task as spec says — standalone script invoked by AWS EventBridge Scheduler
	C. In-process but as a separate Fastify plugin / startup hook in the REST API process
	D. Other: [please specify]

	**Answer:** C

5. The spec says the startup scanner should re-enqueue steps with `job_id IS NULL AND status = 'pending'` on service startup. Should this block the server from accepting traffic until it completes?
	A. Yes — block startup, log progress, then start the HTTP server
	B. No — run async in the background; server starts accepting traffic immediately
	C. Run it, but set a timeout: if it takes > 30s, log a warning and continue anyway
	D. Other: [please specify]

	**Answer:** B

6. For `emit_event` action type, what does the step DSL look like? The spec shows `send_message` and `send_email` examples but not `emit_event`.
	A. `{ "type": "emit_event", "params": { "event_type": "...", "payload": { ... } } }` — literal payload, field interpolation applied
	B. `{ "type": "emit_event", "params": { "event_type": "...", "payload_field": "context" } }` — entire enrollment context forwarded as payload
	C. Both: a `payload` object with field interpolation, plus an optional `include_context: true` flag to merge enrollment context
	D. Other: [please specify]

	**Answer:** C

7. The spec says enrolling while `sequence_definitions.status = 'disabled'` should reject new enrollments. What HTTP response should `POST /sequences/enroll` return for a disabled sequence?
	A. `422 Unprocessable Entity` with error body `{ "error": "sequence_disabled" }`
	B. `409 Conflict`
	C. `404 Not Found` (treat disabled as non-existent to the caller)
	D. Other: [please specify]

	**Answer:** A

8. Can the same entity be enrolled in the same sequence more than once simultaneously (using different `dedup_key` values)?
	A. Yes — multiple concurrent active enrollments for the same `(sequence_id, entity_id)` are allowed
	B. No — a second enroll call for an already-active `(sequence_id, entity_id)` should return an error, regardless of `dedup_key`
	C. No — but return `200 OK` (idempotent no-op) rather than an error
	D. Other: [please specify]

	**Answer:** A

9. The spec specifies BullMQ retry backoff as "5s → 30s → 2m → 10m". How many total attempts should a step make before being marked `failed`?
	A. 4 attempts (1 initial + 3 retries matching the 4-delay progression)
	B. 5 attempts (1 initial + 4 retries)
	C. Configurable via an env variable, default 4
	D. Other: [please specify]

	**Answer:** B

10. For A/B statistical significance (p < 0.05, minimum 100 enrollments per variant), which test should the implementation use?
	A. Two-proportion z-test (standard for conversion rate comparison)
	B. Chi-squared test
	C. Fisher's exact test
	D. Defer this — just expose raw counts and rates in the API; the UI can compute significance client-side

	**Answer:** A

11. The `GET /sequences/:id/stats` endpoint is listed but its response shape is not specified. What fields are required?
	A. Minimal: `{ total_enrollments, completed_count, unenrolled_count, failed_count, completion_rate, unenrollment_rate }`
	B. Full A/B breakdown: above + `{ ab: { A: { enrollments, completions, conversion_count, conversion_rate }, B: { ... }, winner, significant } }`
	C. Both flat stats and per-step breakdown (step completion rate, avg time to complete)
	D. Other: [please specify]

	**Answer:** B

12. What fields should the `nurturing.step_failed` EventBridge event payload contain?
	A. `{ enrollment_id, step_id, entity_type, entity_id, error, attempt_count }`
	B. `{ enrollment_id, step_id, entity_type, entity_id, sequence_id, error, attempt_count, scheduled_at }`
	C. Match the Automation Engine's `automation.step_failed` event shape for consistency
	D. Other: [please specify]

	**Answer:** B

13. The `lead.outbound_sent` event includes `is_first_in_stage`, computed by the Conversation Service by checking prior outbound messages since `stage_entered_at`. Where does the Conversation Service get `stage_entered_at`?
	A. It's stored on the lead record in the Lead Service DB and fetched via API when needed
	B. The Pipeline Engine includes `stage_entered_at` in the `lead.stage_changed` event payload; the Conversation Service caches it locally
	C. The caller (coordinator UI) passes it as a param when logging the outbound message
	D. Other: [please specify]

	**Answer:** A

14. The Automation Engine's `unenroll_sequence` action is a new action type that requires amending the Automation Engine spec and implementation. Is this amendment in scope for this Ralph iteration (i.e., should Ralph modify the Automation Engine service)?
	A. Yes — Ralph should add `unenroll_sequence` to the Automation Engine in this same iteration
	B. No — the Automation Engine amendment is a separate iteration; this iteration delivers the Nurturing Engine only
	C. Partially — add the action type definition/interface only, defer the full worker implementation
	D. Other: [please specify]

	**Answer:** C

15. The `lead.outbound_sent` and `lead.activity_logged` events must be added to `@ortho/event-bus` (the spec notes "arch doc amendment required"). Should Ralph implement these event type additions in this iteration?
	A. Yes — add both events to `@ortho/event-bus` schema package as part of this iteration
	B. No — assume they are already added; Ralph only implements the Nurturing Engine consumer
	C. Add the TypeScript types to `@ortho/types` only; the actual publishing implementation is done in their respective services' iterations
	D. Other: [please specify]

	**Answer:** C

16. For the `@platform/sequence-ui` Sequence Builder, the spec mentions a "template picker (calls Template Service)." Should the picker call the Template Service directly from the browser, or go through the CRM API Gateway?
	A. Directly from the browser — same pattern as the component's calls to the Nurturing Engine API
	B. Through CRM API Gateway — the UI component should not have direct knowledge of Template Service URLs
	C. It doesn't matter — use whatever is simplest; this is a low-priority detail
	D. Other: [please specify]

	**Answer:** B

17. Contract tests: the spec references a contract test for `POST /sequences/unenroll` outbound call shape. Should Ralph generate contract tests (consumer-driven or shape-based) for all outbound calls from the Nurturing Engine?
	A. Yes — contract tests for all outbound calls: Template Service, Messaging Service, Email Service, AI Service, EventBridge
	B. Yes — but only for the Nurturing-specific calls (enroll/unenroll), not for shared platform service calls
	C. No — integration tests with HTTP interceptors are sufficient; skip dedicated contract tests
	D. Other: [please specify]

	**Answer:** A

18. Should the implementation include seed data or migration scripts that pre-insert the "Contacted — No Response Follow-up" sequence as a bootstrap sequence?
	A. Yes — seed a complete sequence definition (draft status) so operators can activate it without manual UI entry
	B. No — operators create sequences through the UI; no seed data
	C. Yes — but as a documented SQL snippet in the migration comments, not an automated seed script
	D. Other: [please specify]

	**Answer:** C
