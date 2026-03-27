# Clarifying Questions: Automation Engine

> Original request: Generate clarifying questions for the Automation Engine spec at `docs/superpowers/specs/2026-03-24-automation-engine-design.md`

## Questions

1. Rules are described as global — are they scoped per location, or do all 34 locations share the same rule set?
   A. Global — one rule applies to all locations; location-specific logic goes in conditions (e.g. `payload.location_id eq "loc-123"`)
   B. Per-location — each location has its own isolated rule library
   C. Shared with overrides — rules are global but can be overridden or disabled per location
   D. Other: [please specify]

   **Answer:** D. Rules are global. Some rules may be applied for particular locations given payload contains data "location_id=loc-123"

2. The spec does not mention rule deletion. What happens when a manager wants to remove a rule?
   A. Hard delete — rule and all version history removed from the DB
   B. Soft delete — rule marked `deleted`, hidden from UI, never matched again; history preserved
   C. Only `Disabled` is the terminal state — no true deletion
   D. Other: [please specify]

   **Answer:** B

3. The Rule Matcher uses a 30s TTL in-memory cache with no active invalidation. Is this lag acceptable in all operational scenarios (e.g. emergency disable of a misfiring rule)?
   A. Yes — 30s is acceptable; operators understand the delay
   B. No — add an explicit cache-bust endpoint (e.g. `POST /rules/cache/invalidate`) that ops can trigger
   C. No — shorten the TTL (e.g. 5s) to reduce the window
   D. Other: [please specify]

   **Answer:** D. 30s is acceptable , but exact value comes from ENV vars (config)

4. The `call_ai` action with `auto_send: true` chains into a synthetic `send_message`. Does that synthetic send respect the rule's `active_hours` config?
   A. Yes — the synthetic send_message goes through the same active hours check
   B. No — `auto_send: true` implies urgency; the message is sent immediately regardless of active_hours
   C. Configurable — a separate `auto_send_respects_active_hours` flag on the action
   D. Other: [please specify]

   **Answer:** C

5. When a `send_message` or `send_email` job is delayed by active hours, it can sit in Redis for up to ~24 hours. What is the expected scale of delayed jobs, and is Redis memory pressure a concern?
   A. Low volume — no concern; current Redis allocation is sufficient
   B. Potentially high — need a BullMQ job size cap or Redis memory alert
   C. Unknown — needs a capacity estimate before deciding
   D. Other: [please specify]

   **Answer:** A

6. Can the root node of an `action_tree` be a `branch` node (i.e. a rule with no leading action, only a conditional split)?
   A. Yes — this is a valid and expected pattern
   B. No — the root must be a concrete action type; branch can only appear as a `next` node
   C. Undecided — needs a product decision
   D. Other: [please specify]

   **Answer:** D - your judgement

7. What happens when a `send_message` or `send_email` action is missing its required `dedup_key`?
   A. Schema validation at rule-save time rejects the rule — it cannot be saved without a dedup_key
   B. Worker fails the step immediately with a validation error (no retry)
   C. Worker proceeds without idempotency protection (log a warning)
   D. Other: [please specify]

   **Answer:** C

8. The `call_webhook` action allows arbitrary URLs defined in rule JSON. Is there a URL allowlist or security control to prevent misuse by rule authors?
   A. No restriction — rule authors are trusted staff; no allowlist needed
   B. Domain allowlist configured at the service level — only pre-approved domains permitted
   C. Marketing Manager approval required before any `call_webhook` rule can be activated
   D. Other: [please specify]

   **Answer:** A

9. When a `call_webhook` request times out (default `timeout_ms: 5000`), is it treated the same as a transient failure and retried with exponential backoff?
   A. Yes — timeout is a transient failure; full backoff + dead-letter applies
   B. Yes for retries, but the timeout value is per-attempt (not cumulative)
   C. No — timeout immediately moves the step to `failed` (no retry) to avoid duplicate side effects on idempotent-unsafe endpoints
   D. Other: [please specify]

   **Answer:** C

10. How is the `@platform/automation-ui` component told which Automation Engine API base URL to use? The spec says it calls the service directly from the browser.
    A. Injected as a React prop by the CRM shell at mount time (`<AutomationUI apiBaseUrl="..." />`)
    B. Read from a global env/config object that the CRM shell sets on the window
    C. Hardcoded to a well-known internal URL (e.g. via env var baked at build time)
    D. Other: [please specify]

    **Answer:** C

11. Are Marketing Staff allowed to view the Execution Log, or is it restricted to Marketing Managers?
    A. Both roles can view the Execution Log (read-only for Staff)
    B. Execution Log is Manager-only
    C. Staff can see executions for rules they authored; Managers see all
    D. Other: [please specify]

    **Answer:** B

12. The spec does not mention execution log retention or cleanup. How long should execution records be kept?
    A. Indefinitely — no automated cleanup
    B. Rolling window (e.g. 90 days), older rows purged by a scheduled job
    C. Configurable per deployment via an env var
    D. Other: [please specify]

    **Answer:** C, 90 days by default

13. If an event arrives for a rule whose `active_version` was just activated (within the 30s cache window) — i.e. the Execution Manager has the old version cached — which version's `action_tree` is snapshotted?
    A. The cached (old) version — accepted as a known race; cache TTL limits the window
    B. The Execution Manager always re-fetches from DB at snapshot time (no cache for the version used in execution)
    C. This is a gap — needs a decision
    D. Other: [please specify]

    **Answer:**  A

14. Can a manager preview or test-run a Draft rule against a sample event payload before activating it?
    A. No — Draft rules must be manually inspected; no test mode
    B. Yes — the Rule Builder UI should have a "Test with sample event" feature that runs the condition evaluator in-browser (no actual actions dispatched)
    C. Yes — a `POST /rules/:id/test` endpoint runs the full evaluation and returns what would execute (dry-run, no side effects)
    D. Other: [please specify]

    **Answer:** D - both B & C

15. The `call_ai` action references a `model` field (`haiku` or `sonnet`). Who decides which model to use for a given rule — the marketing manager in the UI, or is it fixed per action type?
    A. Marketing manager selects the model in the Rule Builder UI per `call_ai` node
    B. Fixed by rule type — AI draft rules always use a configured default (e.g. haiku for speed)
    C. Platform default; only engineering can override via config
    D. Other: [please specify]

    **Answer:** C

16. When a `branch` node is reached and the losing path's steps are marked `skipped`, are those skipped steps visible in the Execution Log UI? If so, how?
    A. Yes — all steps shown with a `–` (skipped) badge; losing path clearly visualized
    B. Yes — shown collapsed/greyed out, expandable on demand
    C. No — only the executed path's steps are shown; skipped steps hidden for clarity
    D. Other: [please specify]

    **Answer:** A

17. Is there a maximum supported nesting depth for `branch` nodes in an `action_tree`? Deeply nested trees could be complex to build and debug.
    A. No enforced limit — UI must handle arbitrary depth gracefully
    B. Hard cap (e.g. 3 levels of nesting) enforced at rule-save time
    C. No limit in the engine; the Rule Builder UI warns but doesn't block beyond a recommended depth
    D. Other: [please specify]

    **Answer:** B

18. The spec says in-flight executions complete normally when a rule is `Disabled`. What happens to BullMQ jobs that are delayed (e.g. waiting for active hours to open) when their rule is disabled mid-wait?
    A. Delayed jobs are allowed to complete — the rule snapshot was taken at trigger time and is already committed
    B. Delayed jobs are cancelled when the rule is disabled
    C. No decision yet — this is a gap
    D. Other: [please specify]

    **Answer:** B
