# Clarifying Questions: AI Service

> Original request: Implement the AI Service (`apps/platform/ai`) per the approved design spec at `docs/superpowers/specs/2026-03-25-ai-service-design.md` — Claude API gateway with prompt registry, context injection, two-layer response cache, and Arize Phoenix instrumentation.

## Questions

1. Which library should be used for the L1 in-memory LRU cache?
   A. `lru-cache` npm package (most common, well-maintained)
   B. `mnemonist` LRUCache
   C. Custom Map-based implementation (no dependency)
   D. Other: [please specify]

   **Answer:** A

2. The spec says the L2 cache write is "fire-and-forget after the Claude response is returned." How should this be implemented?
   A. `void repo.upsert(...)` — do not await, return response immediately
   B. Await the write but do not let it fail the request (try/catch, swallow error)
   C. `setImmediate(() => repo.upsert(...))` — defer to next event loop tick
   D. Other: [please specify]

   **Answer:** A

3. Which HTTP interceptor library should be used for mocking Claude API calls in integration tests?
   A. `nock` — Node HTTP interceptor
   B. `msw` (Mock Service Worker) — handler-based
   C. `@anthropic-ai/sdk` mock via `vi.mock()`
   D. Other: [please specify]

   **Answer:** C

4. The Arize Phoenix instrumentation requires registering before the Anthropic SDK is imported. How should startup order be enforced?
   A. Register instrumentation at the top of `index.ts` before any other imports (rely on ESM import order)
   B. Use a dedicated `instrumentation.ts` file imported first in `index.ts`
   C. Use Node.js `--require` / `--import` flag to run instrumentation setup before the app
   D. Other: [please specify]

   **Answer:** B

5. What should happen when the `ARIZE_PHOENIX_ENDPOINT` env var is unset?
   A. Skip `registerInstrumentations` call entirely — no instrumentation registered
   B. Call `registerInstrumentations` with `AnthropicInstrumentation` regardless — SDK no-ops when no exporter is configured
   C. Log a startup warning and skip instrumentation
   D. Other: [please specify]

   **Answer:** B

6. The context injector replaces `{{key}}` tags with dot-notation support. What should happen if a context value is not a string (e.g., a number, boolean, or nested object)?
   A. Call `.toString()` on the value (numbers/booleans render naturally; objects render as `[object Object]`)
   B. `JSON.stringify()` non-string values
   C. Only support string values — log a warning and replace with empty string for non-strings
   D. Other: [please specify]

   **Answer:** A

7. How deep should dot-notation resolution go in the context injector?
   A. Arbitrary depth (recursively resolve any `a.b.c.d` path)
   B. Max two levels (`lead.name` supported; `lead.address.city` not)
   C. No stated limit — implement arbitrarily deep and document it
   D. Max three levels (`lead.name` supported, `lead.address.city` supported, `foo.bar.baz.xxx` not)

   **Answer:** D

8. Which database access pattern should the `completions` repository use?
   A. Knex query builder (consistent with stack default)
   B. Raw `pg` client with parameterized queries
   C. Drizzle ORM
   D. Other: [please specify]

   **Answer:** B

9. The spec defines `platform_ai` as the database schema. How is the schema namespace applied?
   A. All queries use `platform_ai.ai_completions` (explicit schema prefix)
   B. `search_path` is set per connection to `platform_ai` — queries use bare table name
   C. Separate database (not schema) named `platform_ai`
   D. Other: [please specify]

   **Answer:** B

10. How should Anthropic API errors be classified to return `503`?
    A. Catch all errors from `anthropic.messages.create()` and return 503 regardless of type
    B. Inspect `error.status` — return 503 for 429, 529, and 5xx; re-throw unexpected errors
    C. Use `APIError` / `RateLimitError` / `APIStatusError` from the Anthropic SDK for typed error handling
    D. Other: [please specify]

    **Answer:** C

11. Should the lazy cleanup DELETE (`WHERE expires_at < NOW() - INTERVAL '1 hour'`) run on every L2 write, or only on L2 cache-miss writes?
    A. Every L2 write (including the upsert on cache miss) — as spec describes
    B. Only on confirmed cache-miss writes (skip if row already existed via ON CONFLICT)
    C. Probabilistically — run on ~10% of writes to reduce DB load
    D. Other: [please specify]

    **Answer:** A

12. The `context` field validation rejects `null`, strings, and arrays — only plain objects are valid. Should TypeBox validation or manual runtime checks be used for this?
    A. TypeBox `Type.Object({}, { additionalProperties: Type.Unknown() })` — rejects non-objects at schema level
    B. Manual `typeof context !== 'object' || context === null || Array.isArray(context)` check in route handler
    C. TypeBox for the outer shape, manual check for null/array edge cases TypeBox doesn't distinguish
    D. Support plain objects and Arrays.  rely on TypeBox validation and manual runtime checks

    **Answer:** D

13. For the `conversation-agent-reply` prompt, the spec says the AI Service returns the raw text string from Claude — it does NOT parse or validate the JSON. Should the service add any annotation to help the caller identify structured responses?
    A. No — return raw `text` exactly as received from Claude; caller is responsible for parsing
    B. Add a `structured: true` flag in the response when the prompt definition has a known JSON format
    C. Log a warning if the response doesn't parse as valid JSON (for observability) but still return raw text
    D. Other: [please specify]

    **Answer:** B

14. What is the intended rollout order for the prompt definitions? Should all 9 prompts be stubbed in at once, or implemented incrementally?
    A. All 9 prompts implemented with real system/user prompt content from day one
    B. All 9 registered in the registry with placeholder content — real prompts filled in later
    C. Only implement prompts needed by the first calling service (Automation Engine / Conversation Service)
    D. Other: [please specify]

    **Answer:** A

15. Should the service expose a health check endpoint (e.g. `GET /health`) for ECS/load balancer liveness probes?
    A. Yes — `GET /health` returning `200 { status: "ok" }` (standard for all services)
    B. No — not in scope for this spec; add later
    C. Yes — and include DB connectivity check in the response
    D. Other: [please specify]

    **Answer:** A

