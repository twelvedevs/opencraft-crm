# Clarifying Questions: Template Service

> Original request: Implement the Template Service as specified in `docs/superpowers/specs/2026-03-25-template-service-design.md` — backend service (`apps/platform/template`) + `@platform/template-ui` React component package.

## Questions

### Scope

1. Is `@platform/template-ui` (the Unlayer email editor + SMS editor React component package) in scope for this Ralph implementation pass, or is the backend service (`apps/platform/template`) the only deliverable?
	- A. Backend service only — UI is a separate task
	- B. Both backend service and `@platform/template-ui` in the same pass
	- C. Backend first, then a separate Ralph task for the UI

	**Answer:** A

2. Should the Ralph task include the Unlayer (`react-email-editor`) npm dependency setup and package scaffold for `packages/@platform/template-ui`, or is the package already scaffolded?
	- A. Create the package from scratch including `package.json`, `tsconfig.json`, Vite config
	- B. Package scaffold already exists — just implement the components
	- C. Not in scope for this pass

	**Answer:** C

---

### Data Model & Validation

3. Should the `templates.name` field be unique (globally across all templates, per channel, or not unique at all)?
	- A. Globally unique — `UNIQUE(name)` constraint on the `templates` table
	- B. Unique per channel — `UNIQUE(name, channel)`
	- C. Not unique — no constraint, just a display label

	**Answer:** A

4. Are there length constraints on template content fields?
	- A. No hard limits — accept any length PostgreSQL `text` supports
	- B. Soft limits enforced in validation (e.g., SMS `body_text` ≤ 1600 chars, email fields ≤ configurable max)
	- C. SMS body only limited (e.g., 1600 chars / 10 segments); email fields unconstrained

	**Answer:** B

5. Is the `created_by` field populated from the JWT sub claim, or is it optional/caller-supplied?
	- A. Always populated from the JWT `sub` claim — callers cannot override it
	- B. Optional — stored if present in the JWT, left NULL if not
	- C. Caller-supplied in the request body

	**Answer:** B

---

### API Behavior Edge Cases

6. Can a `draft`-only template (one that has never been activated, `active_version IS NULL`) be disabled via `POST /templates/:id/disable`?
	A. Yes — any template can be disabled regardless of status
	B. No — `disable` only applies to `active` templates; return `400` for `draft` or already `disabled`
	C. Yes, but it should return a warning in the response

	**Answer:** C

7. What happens when `PATCH /templates/:id` is called on a `disabled` template?
	- A. Allowed — disabled templates can still have their draft edited
	- B. Rejected with `409` — must re-enable before editing
	- C. Allowed, but the edit does not automatically re-enable the template

	**Answer:** A

8. Is there an endpoint to **discard a pending draft** and reset `current_version` back to `active_version`?
	- A. No — drafts can only move forward (edit or activate); no discard
	- B. Yes — add `POST /templates/:id/discard-draft` to reset to active content
	- C. Not in scope for v1 — can be added later

	**Answer:** C

9. `GET /templates` (list) — does this endpoint need pagination?
	- A. No pagination — return all templates in a single response (the dataset is small)
	- B. Yes — offset/limit pagination with `?limit=` and `?offset=` query params
	- C. Cursor-based pagination

	**Answer:** B

10. What filtering/sorting is supported on `GET /templates`?
	- A. No filtering or sorting — return all templates unsorted
	- B. Filter by `channel` and/or `status` via query params; no sorting
	- C. Filter by `channel` and/or `status`; sort by `created_at` or `updated_at` (default: `updated_at DESC`)

	**Answer:** C

---

### Merge Tag Rendering

11. How should the renderer handle **malformed merge tag syntax** (e.g., `{{` with no closing `}}`, or `{{ }}` empty tag)?
	- A. Leave malformed tags unchanged in the output (passthrough)
	- B. Replace with empty string (same as missing key)
	- C. Return a `400` render error — malformed templates should have been caught at save time

	**Answer:** C

12. Should merge tag keys be **case-sensitive** (i.e., is `{{First_Name}}` different from `{{first_name}}`)?
	- A. Case-sensitive — keys must match context exactly
	- B. Case-insensitive — normalize both key and context to lowercase before matching

	**Answer:** B

13. Should the renderer support **array indexing** in dot-notation (e.g., `{{appointments.0.date}}`) or only object property paths?
	- A. Object paths only — no array indexing needed in v1
	- B. Array index support is required (e.g., `{{appointments.0.date}}`)

	**Answer:** A

---

### Caching

14. What in-memory cache implementation should be used for the 30s TTL cache?
	A. Simple `Map` with manual `setTimeout`-based expiry (no dependencies)
	B. `node-cache` npm package
	C. `lru-cache` npm package
	D. Other: [please specify]

	**Answer:** C

15. On `POST /templates/:id/disable`, the spec says to eagerly evict the cache entry. Should `POST /templates/:id/activate` also eagerly populate (warm) the cache with the new active version content?
	A. Yes — activate should eagerly warm the cache so render latency is minimal immediately after activation
	B. No — activate only evicts the old cache entry; next render triggers a fresh DB fetch and caches the result
	C. Activate neither warms nor evicts — rely on TTL expiry

	**Answer:** B

---

### Auth & RBAC

16. How is RBAC enforced for Marketing Manager-only actions (`activate`, `disable`, `enable`)? The spec says "enforced via Identity Service JWT RBAC."
	- A. Use the existing `@ortho/auth-middleware` package — it decodes the JWT and exposes `req.user.role`; the route handler checks the role
	- B. Add a dedicated `requireRole('marketing_manager')` middleware from `@ortho/auth-middleware`
	- C. The CRM API Gateway enforces role restrictions before forwarding — the Template Service trusts all requests that reach it

	**Answer:** A+B

17. Are the CRUD endpoints (`POST /templates`, `GET /templates`, `GET /templates/:id`, `PATCH /templates/:id`) accessible to **both** Marketing Staff and Marketing Manager, or are some restricted?
	- A. All CRUD endpoints are open to both roles (plus any authenticated user)
	- B. `POST /templates` (create) requires at least Marketing Staff; reads are unrestricted
	- C. All endpoints require at least Marketing Staff role

	**Answer:** C

---

### Error Responses

18. What error response shape should the service use? (For consistency with other services in the monorepo.)
	- A. Fastify default error format: `{ statusCode, error, message }`
	- B. Custom envelope: `{ success: false, error: { code, message } }`
	- C. Match the shape used by the Automation Engine / Messaging Service (check existing services)

	**Answer:** C

---

### Testing

19. What tool/approach should be used for the contract test covering `POST /templates/render`?
	- A. Simple JSON schema validation with `@sinclair/typebox` (consistent with how other services do it)
	- B. Pact consumer-driven contract tests
	- C. A separate Vitest test file that validates request/response shapes

	**Answer:** C

20. For integration tests, should the test database be created per-test-run via migrations (same as Automation Engine / Nurturing Engine pattern), or is a shared test schema assumed?
	- A. Run migrations against a dedicated test DB at the start of the integration test suite — same as existing services
	- B. Use Docker Compose to spin up a fresh Postgres instance per test run
	- C. Tests assume a pre-existing schema — no migration step in the test suite

	**Answer:** A

---

### `@platform/template-ui` (if in scope)

21. Should the **merge tag helper** in the SMS editor show a hardcoded list of common tags, a configurable list passed as a prop, or tags discovered from the active template's context schema?
	- A. Hardcoded list of common tags (e.g., `first_name`, `location_name`, `referral_link`)
	- B. Configurable `availableTags` prop passed in by the consuming app
	- C. Dynamically fetched from a tags registry endpoint (out of scope for this service)

	**Answer:** not in scope

22. Should the Unlayer email editor **auto-strip HTML to generate the plain-text fallback** on first export, or is the plain-text field always manually entered?
	- A. Auto-strip on first export (using a library like `html-to-text`) — user can then manually refine
	- B. Always manually entered — no auto-strip behavior
	- C. Auto-strip on every export, overwriting any manual edits

	**Answer:** not in scope

23. Is the **Unlayer editor** embedded via a licensed Unlayer account (requiring a `projectId`) or the free/open-source `react-email-editor` without a project ID?
	- A. Free / open-source — no `projectId` required
	- B. Licensed Unlayer account — `projectId` will be provided via environment variable
	- C. Not decided yet — stub the editor integration with a placeholder

	**Answer:** not in scope
