# AI Service — Updated Design Spec

**Date:** 2026-03-30
**Status:** Approved
**Scope:** Platform-layer AI Service — Claude API gateway, prompt registry, context injection, two-layer response cache, Arize Phoenix instrumentation
**Supersedes:** `2026-03-25-ai-service-design.md`
**Changes:** Incorporates clarifying Q&A decisions (library choices, validation rules, error handling, response shape, health check endpoint)

---

## 1. Overview

The AI Service (`apps/platform/ai`) is a **thin Claude API gateway**. It is fully domain-agnostic — it has no knowledge of leads, pipelines, coordinators, or any Ortho CRM concepts.

**Core responsibilities:**
- Resolve `prompt_id` → system prompt + user prompt template from a static in-code registry
- Inject caller-supplied context into prompt templates via `{{merge_tag}}` substitution
- Route to Claude Sonnet 4.6 (complex tasks) or Haiku 4.5 (high-volume) — prompt defines default, caller can override
- Cache responses by content hash: L1 in-memory LRU 60s TTL (`lru-cache`) + L2 Postgres 5min TTL for cross-instance dedup
- Instrument all Claude calls via Arize Phoenix SDK for LLM observability

**Callers:**
- Automation Engine `call_ai` worker → `POST /ai/complete`
- Conversation Service → `POST /ai/complete` (reply drafts, objection handling, agent replies, conversation summaries)

**Out of scope:**
- AI Agent autonomous mode (conversation management, escalation logic) — product layer (Conversation Service)
- Streaming responses — all completions are synchronous
- Prompt management UI — prompts are static code, versioned in git
- Usage metering DB table — Arize Phoenix captures all token/latency data

**No events published.** Purely request/response — no calls to other services, no EventBridge.

> **Note:** The platform architecture doc (Section 2.1) describes the AI Service as including "streaming" and "usage metering." Both are out of scope for this design (streaming not needed; metering handled by Arize Phoenix). The arch doc requires an amendment to remove those two capabilities from the AI Service row.

---

## 2. Architecture

```
Automation Engine (call_ai worker)
Conversation Service
        │
        ▼  POST /ai/complete
┌────────────────────────────────────────────┐
│              AI Service                     │
│   apps/platform/ai                          │
│                                             │
│  REST API                                   │
│    ├── GET  /health                         │
│    └── POST /ai/complete                    │
│                                             │
│  Prompt Registry  (static TS files)         │
│    └── resolves prompt_id → definition      │
│                                             │
│  Context Injector  (pure function)          │
│    └── {{merge_tag}} substitution           │
│                                             │
│  Completion Cache                           │
│    ├── L1: lru-cache, 60s TTL, 500 entries  │
│    └── L2: Postgres, 5min TTL              │
│                                             │
│  Claude Client  (Anthropic SDK)             │
│    └── Arize Phoenix instrumentation        │
│                                             │
│  Repository  (platform_ai DB, raw pg)       │
└────────────────────────────────────────────┘
        │
        ▼  text response
Automation Engine / Conversation Service
```

---

## 3. API

### `GET /health`

ECS/load balancer liveness probe.

**Response:**
```json
{ "status": "ok" }
```

Always returns `200`. No DB connectivity check.

---

### `POST /ai/complete`

The single completion endpoint. Internal service-to-service — no JWT auth required (same VPC).

**Request:**
```json
{
  "prompt_id": "smart-reply-draft",
  "context": {
    "conversation_history": "...",
    "lead_stage": "Contacted",
    "location_name": "Ortho North"
  },
  "model": "haiku"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt_id` | string | Yes | Must match a registered prompt definition |
| `context` | object \| array | Yes | Arbitrary key-value data (plain object) or array; injected into prompt template. `null`, strings, and numbers are rejected. |
| `model` | `"haiku"` \| `"sonnet"` | No | Overrides prompt's `defaultModel` |

**Validation — `context` field:**
- TypeBox validates the outer request shape
- Manual runtime check rejects `null`, primitive values (string, number, boolean)
- Plain objects `{}` and arrays `[]` are both accepted
- Empty object `context: {}` is valid

**Response:**
```json
{
  "text": "Hi Sarah! Just checking in — are you still interested in scheduling your free exam?",
  "model": "claude-haiku-4-5-20251001",
  "prompt_id": "smart-reply-draft",
  "cached": true,
  "structured": false
}
```

| Field | Type | Description |
|---|---|---|
| `text` | string | Raw completion text from Claude (never parsed by this service) |
| `model` | string | Resolved Anthropic model ID |
| `prompt_id` | string | Echo of the requested prompt |
| `cached` | boolean | `true` if served from L1 or L2 cache |
| `structured` | boolean | `true` if the prompt definition sets `structured: true` — signals caller that `text` is expected to be JSON. Service does NOT parse or validate the JSON content. |

**Error responses:**

All errors return `{ "error": "<message>" }`.

- `400` — missing `prompt_id`; missing `context`; `context` is a null, string, number, or boolean; `model` present but not `"haiku"` or `"sonnet"`
- `404` — `prompt_id` not found in registry
- `503` — Claude API error (covers `RateLimitError` 429, `APIStatusError` 529 and all 5xx, `APIError` for unexpected SDK errors) — caller handles retry (BullMQ backoff in Automation Engine; direct retry in Conversation Service)

No `dedup_key` field on the request. Idempotency is handled by the content hash cache — two calls with identical `(prompt_id, context, resolved_model)` within 5 minutes return the same response from L2 cache.

---

## 4. Prompt Registry

Prompts are static TypeScript objects in `src/prompts/`, loaded at startup into an in-memory `Map<string, PromptDefinition>`. No DB. No hot-reload — prompt changes require a deployment.

```typescript
interface PromptDefinition {
  id: string;
  defaultModel: 'haiku' | 'sonnet';
  systemPrompt: string;
  userPromptTemplate: string;
  maxTokens?: number;    // defaults to 500
  structured?: boolean;  // true = response is expected JSON; echoed in API response as `structured` field
}
```

**Context injection** uses `{{key}}` syntax with dot-notation support up to **three levels deep** (`{{lead.name}}`, `{{lead.address.city}}` — but not `{{a.b.c.d}}`). Paths deeper than three segments are treated as not found (empty string replacement + log warning).

**Non-string context values:** Resolved values that are not strings have `.toString()` called on them before substitution. Numbers and booleans render naturally (`42`, `true`). Nested objects render as `[object Object]` — callers are responsible for pre-serializing nested objects if needed.

**Missing keys:** Replaced with empty string + structured log warning via `@ortho/logger`. No throw.

**Model resolution order:** explicit `model` field in request → prompt's `defaultModel`.

**Model ID mapping:**
- `"haiku"` → `claude-haiku-4-5-20251001` (the `-20251001` date suffix is part of the Anthropic API model ID)
- `"sonnet"` → `claude-sonnet-4-6` (no date suffix; stable versioned ID for this model family)

The asymmetry in ID format is intentional — it reflects the actual Anthropic API model identifiers.

### Registered Prompts

All 9 prompts are implemented with real system/user prompt content from day one.

| `prompt_id` | Default model | `structured` | Purpose |
|---|---|---|---|
| `smart-reply-draft` | `haiku` | `false` | Draft 2–3 reply options for an inbound SMS conversation |
| `sequence-personalization` | `haiku` | `false` | Personalize a template message for a specific lead |
| `objection-handling` | `sonnet` | `false` | Suggest response strategies when coordinator flags an objection |
| `conversation-summary` | `haiku` | `false` | Summarize a long conversation thread into a 3-sentence briefing |
| `follow-up-timing` | `haiku` | `false` | Suggest optimal next follow-up timing based on lead behavior |
| `lead-scoring-commentary` | `haiku` | `false` | Explain why a lead is scored high or low |
| `conversation-reply-drafts` | `haiku` | `false` | Generate 2–3 draft reply options for a coordinator, given the full conversation thread and lead context |
| `conversation-objection-handling` | `sonnet` | `false` | Suggest strategies for handling patient objections (cost concerns, scheduling hesitation). Returns structured suggestions. |
| `conversation-agent-reply` | `haiku` | `true` | Generate a single autonomous reply for AI Agent mode. Returns `{ text: string, escalate: boolean }` as JSON. Parse failure by caller treated as escalation. |

**`conversation-agent-reply` structured output:** The system prompt instructs the model to always respond as JSON `{ "text": "<reply>", "escalate": <boolean> }`. The AI Service returns the raw Claude output as `text` and sets `structured: true` in the response. It does NOT parse or validate the JSON. Conversation Service parses; any parse failure is treated as `escalate: true`.

---

## 5. Response Cache

### Cache Key

`SHA256(prompt_id + ":" + resolved_model + ":" + canonicalized JSON(context))`

Context is serialized with recursively sorted keys before hashing — identical context objects with different key insertion order produce the same hash.

### L1 — In-Memory LRU Cache

Implemented with the **`lru-cache`** npm package.

- **TTL:** 60 seconds
- **Max entries:** 500
- LRU eviction applies when the 500-entry cap is reached. TTL expiry is the primary eviction trigger; the cap prevents unbounded memory growth under high load with many distinct cache keys.

### L2 — Postgres Cache

- **TTL:** 5 minutes (`expires_at = NOW() + INTERVAL '5 minutes'` on write)
- Cross-instance dedup — shared by all ECS task instances

### Cache Flow

```
POST /ai/complete
  → resolve prompt definition (404 if not found)  ← structured flag is read here
  → resolve model (request override or prompt default)
  → compute cache_key
  → L1 lru-cache hit? → return (cached: true, structured: from prompt def)
  → L2 Postgres: SELECT WHERE cache_key = ? AND expires_at > NOW()
      HIT  → populate L1 → return (cached: true, structured: from prompt def)
      MISS → call Claude API
           → INSERT ai_completions ON CONFLICT (cache_key)
               DO UPDATE SET response_text = EXCLUDED.response_text,
                             expires_at = EXCLUDED.expires_at
           → void repo.upsert(...)   ← fire-and-forget, not awaited
           → populate L1
           → return (cached: false, structured: from prompt def)
```

The `structured` field in the response always derives from the prompt definition resolved in step 1 — it is never stored in `ai_completions`. The cache stores only `response_text`.

The L2 write is fire-and-forget (`void repo.upsert(...)`): the Claude response is returned to the caller immediately without waiting for the DB write to complete. Write errors are logged but never surface to the caller.

The `ON CONFLICT` upsert handles the concurrent miss race — two ECS instances that simultaneously miss both cache layers both call Claude, but only one row is written; the second upserts harmlessly. Because LLM responses are non-deterministic, the two callers may receive slightly different `text` values. This is acceptable: the cache goal is cost efficiency and burst dedup, not strict response consistency. Once either response is written to L2, all subsequent callers within the TTL window receive that cached response.

### Lazy Cleanup

On **every L2 write** (the `void repo.upsert(...)`):

```sql
DELETE FROM ai_completions WHERE expires_at < NOW() - INTERVAL '1 hour'
```

The 1-hour grace period beyond the 5-minute TTL avoids a cleanup/read race: expired rows are already excluded by the L2 SELECT (`expires_at > NOW()`) so they never serve stale responses; the grace period prevents a concurrent request from racing against the DELETE after computing the cache key. Write frequency is low enough that inline cleanup is sufficient. No BullMQ job needed.

---

## 6. Data Model — `platform_ai`

**Schema access:** `search_path` is set to `platform_ai` per connection. All queries use bare table names (e.g., `ai_completions`, not `platform_ai.ai_completions`). The connection pool sets `search_path` at connection creation time.

`ai_completions` is a **response cache only** — not an audit log. It does not store the original context, rendered prompt, or token counts. Those are captured by Arize Phoenix. Do not add context or token columns here.

```sql
ai_completions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key     text NOT NULL,
  prompt_id     text NOT NULL,
  model         text NOT NULL,
  response_text text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT NOW(),

  UNIQUE (cache_key)
);

CREATE INDEX ON ai_completions (expires_at);  -- supports cleanup scan
```

---

## 7. Arize Phoenix Integration

Arize Phoenix LLM observability is instrumented at service startup using the OpenInference Anthropic instrumentation. This wraps the Anthropic SDK client automatically — no per-call instrumentation code required in application logic.

**Startup order is enforced via a dedicated `instrumentation.ts` file** that is imported as the first import in `index.ts`, before the Anthropic SDK or any application code is loaded.

```typescript
// src/instrumentation.ts — imported first in index.ts
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { AnthropicInstrumentation } from '@arize-ai/openinference-instrumentation-anthropic';

registerInstrumentations({
  instrumentations: [new AnthropicInstrumentation()],
});
```

```typescript
// src/index.ts
import './instrumentation.js';   // ← must be first import
// ... rest of application imports
```

**`ARIZE_PHOENIX_ENDPOINT` unset behavior:** `registerInstrumentations` is always called regardless of whether the env var is set. The OpenInference SDK operates as a no-op when no OTLP exporter is configured — safe for local development without a Phoenix instance running. No startup warning is emitted.

**Captured automatically per call:** input/output token counts, model ID, latency, full prompt (system + user after context injection), response text.

**Custom span attributes** added by `claude-client.ts` before each call:
- `prompt_id` — for filtering traces by feature in Phoenix UI
- `cached: false` — cache hits never reach `claude-client.ts`; only uncached calls are traced

**Configuration:** Phoenix endpoint set via env var `ARIZE_PHOENIX_ENDPOINT` (e.g. `http://phoenix.internal:6006`).

---

## 8. Error Handling — Claude API Errors

Claude API errors are handled in `claude-client.ts` using **typed errors from the Anthropic SDK**:

```typescript
import Anthropic, { APIError, RateLimitError, APIStatusError } from '@anthropic-ai/sdk';

try {
  return await anthropic.messages.create({ ... });
} catch (err) {
  if (err instanceof RateLimitError) {
    // 429 — throw as 503
  } else if (err instanceof APIStatusError) {
    // catches 529 (overload) and all 5xx — throw as 503
  } else if (err instanceof APIError) {
    // unexpected SDK-level error — log and throw as 503
  }
  throw err; // non-Anthropic errors bubble up as 500
}
```

All three error types (429, 529, 5xx) are surfaced to callers as `503`. The caller is responsible for retry logic (BullMQ exponential backoff in Automation Engine; direct retry in Conversation Service).

---

## 9. Infrastructure & Service Layout

```
apps/platform/ai/
├── src/
│   ├── instrumentation.ts           # Arize Phoenix setup — imported first in index.ts
│   ├── routes/
│   │   ├── health.ts                # GET /health → 200 { status: "ok" }
│   │   └── complete.ts              # POST /ai/complete — validation, orchestration
│   ├── services/
│   │   ├── prompt-registry.ts       # Map<string, PromptDefinition>, loaded at startup
│   │   ├── context-injector.ts      # {{merge_tag}} substitution — pure function
│   │   ├── completion-cache.ts      # L1 lru-cache + L2 Postgres, cache_key computation
│   │   └── claude-client.ts         # Anthropic SDK wrapper, typed error handling, Arize span attributes
│   ├── prompts/
│   │   ├── smart-reply-draft.ts
│   │   ├── sequence-personalization.ts
│   │   ├── objection-handling.ts
│   │   ├── conversation-summary.ts
│   │   ├── follow-up-timing.ts
│   │   ├── lead-scoring-commentary.ts
│   │   ├── conversation-reply-drafts.ts
│   │   ├── conversation-objection-handling.ts
│   │   └── conversation-agent-reply.ts
│   ├── repositories/
│   │   └── completions.ts           # ai_completions CRUD — raw pg client, search_path=platform_ai
│   └── index.ts                     # Fastify server — first import: './instrumentation.js'
├── migrations/
├── test/
│   ├── unit/
│   └── integration/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- `lru-cache` — L1 in-memory LRU cache
- `pg` — raw Postgres client (direct, not via Knex)
- `@anthropic-ai/sdk` — Claude API
- `@opentelemetry/instrumentation` + `@arize-ai/openinference-instrumentation-anthropic` — LLM observability
- PostgreSQL (shared RDS cluster, `platform_ai` schema, `search_path` per connection)
- Arize Phoenix — outbound OTLP traces (`ARIZE_PHOENIX_ENDPOINT`)
- No Redis, no BullMQ, no EventBridge

---

## 10. Testing Strategy

### Unit Tests (Vitest)

Pure function coverage — no external dependencies:

- **Context injector:**
  - All tags present → correct substitution
  - Missing key → empty string, no throw, log warning emitted
  - Dot-notation path (1 level): `{{name}}`
  - Dot-notation path (2 levels): `{{lead.name}}`
  - Dot-notation path (3 levels): `{{lead.address.city}}`
  - Dot-notation path (4+ levels): treated as missing → empty string
  - Multiple occurrences of same tag all replaced
  - No tags in template → passthrough unchanged
  - Non-string value (number) → `.toString()` applied (`42` → `"42"`)
  - Non-string value (boolean) → `.toString()` applied (`true` → `"true"`)
  - Non-string value (nested object) → `.toString()` applied (`[object Object]`)

- **Prompt registry:**
  - Known `prompt_id` resolves to correct definition
  - Unknown `prompt_id` returns null
  - `structured: true` prompt returns definition with that flag set

- **Cache key computation:**
  - Identical context objects with different key insertion order produce identical hash
  - Different context → different hash
  - Different `prompt_id` → different hash
  - Different resolved model → different hash

- **Model resolution:**
  - Explicit `model` field in request overrides prompt `defaultModel`
  - Absent `model` field uses prompt `defaultModel`
  - `"haiku"` maps to `claude-haiku-4-5-20251001`
  - `"sonnet"` maps to `claude-sonnet-4-6`

### Integration Tests (Vitest + real Postgres, Claude mocked via `vi.mock('@anthropic-ai/sdk')`)

Claude API calls are intercepted by mocking the `@anthropic-ai/sdk` module with `vi.mock()`. The mock returns controlled responses or throws typed SDK errors (`RateLimitError`, `APIStatusError`) as needed per test case.

- Happy path → correct response returned, `cached: false`, `structured: false`
- `conversation-agent-reply` prompt → response includes `structured: true`
- Unknown `prompt_id` → 404
- Missing `context` → 400
- Missing `prompt_id` → 400
- `context` is `null` → 400
- `context` is a string → 400
- `context` is a number → 400
- `context: []` (array) → 200 (arrays accepted)
- Invalid `model` value (e.g. `"gpt-4"`) → 400
- L1 cache hit → Claude not called, `cached: true`
- L2 cache hit (L1 cold) → Claude not called, `cached: true`, L1 populated for subsequent request
- Expired L2 entry (`expires_at` in past) → Claude called again, new entry written
- Concurrent identical requests → upsert handles race, no unique constraint error
- Claude throws `RateLimitError` (429) → service returns 503
- Claude throws `APIStatusError` with status 529 → service returns 503
- Claude throws `APIStatusError` with status 500 → service returns 503
- L2 write error (pg failure) → response still returned to caller, error logged
- Lazy cleanup: write with expired rows present → expired rows deleted after write
- `GET /health` → 200 `{ "status": "ok" }`

### Contract Tests

- **Outbound:** Claude API request shape — `model`, `system`, `messages[0].role`, `messages[0].content`, `max_tokens` match expected Anthropic SDK format
- **Inbound:** `POST /ai/complete` validates `prompt_id` is a non-empty string, `context` is an object or array (not null/string/number)

---

## 11. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Prompt storage | Static TypeScript files | Prompts are engineering artifacts — they need code review, testing, and git history, not a DB management UI. Changes deploy with the service. |
| Response cache | L1 `lru-cache` 60s + L2 Postgres 5min | In-memory handles burst; Postgres handles cross-instance dedup without adding Redis as a new dependency. |
| L1 implementation | `lru-cache` npm package | Well-maintained, supports TTL + LRU eviction natively. No custom Map implementation needed. |
| Cache idempotency | Content hash (`prompt_id + model + context`) | Natural dedup key — same inputs always produce the same hash, eliminating need for a caller-supplied `dedup_key`. |
| L2 write | `void repo.upsert(...)` — fire-and-forget | Response returned immediately without waiting for DB write. Write errors logged but never fail the request. |
| Concurrent miss handling | `ON CONFLICT DO UPDATE` upsert | Two instances missing simultaneously both call Claude; upsert prevents unique constraint errors and last writer wins harmlessly. |
| Lazy cache cleanup | Inline DELETE on every L2 write | Write frequency is low (only on cache misses). No BullMQ job needed. |
| Model routing | Caller override > prompt default | Each prompt defines its sensible default; callers can override per use-case for cost optimization. |
| Context injection syntax | `{{key}}` with dot-notation (max 3 levels) | Consistent with Template Service merge tag syntax. Three levels covers all real use cases (`lead.address.city`). |
| Non-string context values | `.toString()` | Numbers/booleans render naturally; callers responsible for pre-serializing nested objects. Consistent with Template Service behavior. |
| Missing context keys | Empty string + log | Silent degradation — consistent with Template Service. A missing `{{first_name}}` produces "Hi !" rather than a 500. |
| Context validation | TypeBox + manual null/primitive check | TypeBox handles schema shape; manual check rejects null and primitive values. Arrays accepted alongside plain objects. |
| `structured` response field | Echo prompt definition flag | Signals callers (e.g. Conversation Service) that `text` is expected JSON without the service parsing it. `conversation-agent-reply` is the only current structured prompt. |
| Repository | Raw `pg` client | Direct parameterized queries — no ORM overhead for a single-table cache service. |
| Schema namespace | `search_path=platform_ai` per connection | Queries use bare table names; schema isolation maintained at connection level. |
| Claude error handling | Typed SDK errors (`RateLimitError`, `APIStatusError`, `APIError`) | Precise error classification, avoids catching non-Anthropic errors. 429, 529, and 5xx all map to 503. |
| Instrumentation startup | Dedicated `instrumentation.ts`, first import | Ensures OpenInference wraps the SDK before any code imports it. Explicit, reviewable, ESM-safe. |
| `ARIZE_PHOENIX_ENDPOINT` unset | Always register, SDK no-ops | No conditional startup logic. Safe for local dev without Phoenix running. |
| Test mocking | `vi.mock('@anthropic-ai/sdk')` | Module-level mock gives full control over return values and thrown errors without HTTP interception complexity. |
| Streaming | None | Not needed — coordinators receive full draft at once; Automation Engine workers are async (BullMQ). |
| No events published | None | AI Service is purely request/response. No state changes require downstream reaction. |
| AI Agent mode | Product layer (Conversation Service) | Stateful conversation management, escalation logic, and human handoff are Ortho CRM concerns — not platform-layer responsibilities. |
| Health check | `GET /health` → `{ status: "ok" }` | Standard liveness probe for ECS/load balancer. No DB check — startup failure is the signal, not a health-time DB ping. |
