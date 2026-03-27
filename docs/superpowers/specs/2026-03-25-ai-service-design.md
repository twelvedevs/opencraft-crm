# AI Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Platform-layer AI Service — Claude API gateway, prompt registry, context injection, two-layer response cache, Arize Phoenix instrumentation

---

## 1. Overview

The AI Service (`apps/platform/ai`) is a **thin Claude API gateway**. It is fully domain-agnostic — it has no knowledge of leads, pipelines, coordinators, or any Ortho CRM concepts.

**Core responsibilities:**
- Resolve `prompt_id` → system prompt + user prompt template from a static in-code registry
- Inject caller-supplied context into prompt templates via `{{merge_tag}}` substitution
- Route to Claude Sonnet 4.6 (complex tasks) or Haiku 4.5 (high-volume) — prompt defines default, caller can override
- Cache responses by content hash: L1 in-memory (60s TTL) + L2 Postgres (5min TTL) for cross-instance dedup
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
│    └── POST /ai/complete                    │
│                                             │
│  Prompt Registry  (static TS files)         │
│    └── resolves prompt_id → definition      │
│                                             │
│  Context Injector  (pure function)          │
│    └── {{merge_tag}} substitution           │
│                                             │
│  Completion Cache                           │
│    ├── L1: in-memory, 60s TTL              │
│    └── L2: Postgres, 5min TTL              │
│                                             │
│  Claude Client  (Anthropic SDK)             │
│    └── Arize Phoenix instrumentation        │
│                                             │
│  Repository  (platform_ai DB)               │
└────────────────────────────────────────────┘
        │
        ▼  text response
Automation Engine / Conversation Service
```

---

## 3. API

### `POST /ai/complete`

The single endpoint. Internal service-to-service — no JWT auth required (same VPC).

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
| `context` | object | Yes | Arbitrary key-value data; injected into prompt template |
| `model` | `"haiku"` \| `"sonnet"` | No | Overrides prompt's `defaultModel` |

**Response:**
```json
{
  "text": "Hi Sarah! Just checking in — are you still interested in scheduling your free exam?",
  "model": "claude-haiku-4-5-20251001",
  "prompt_id": "smart-reply-draft",
  "cached": true
}
```

**Error responses:**

All errors return `{ "error": "<message>" }`.

- `400` — missing `prompt_id`; missing `context`; `context` is not an object (`null`, string, array, etc. all rejected — `context: {}` is valid); `model` present but not `"haiku"` or `"sonnet"` (invalid model string falls through to 400, not silently ignored)
- `404` — `prompt_id` not found in registry
- `503` — Claude API error (includes 429 rate-limit and 529 overload from Anthropic API) — caller handles retry (BullMQ backoff in Automation Engine; direct retry in Conversation Service)

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
  maxTokens?: number; // defaults to 500
}
```

**Context injection** uses `{{key}}` syntax with dot-notation support (`{{lead.treatment_interest}}`), identical to the Template Service merge tag resolver. Missing keys → replaced with empty string + structured log warning via `@ortho/logger`. No throw.

**Model resolution order:** explicit `model` field in request → prompt's `defaultModel`.

**Model ID mapping:**
- `"haiku"` → `claude-haiku-4-5-20251001` (Haiku 4.5 — the `-20251001` date suffix is part of the Anthropic API model ID)
- `"sonnet"` → `claude-sonnet-4-6` (Sonnet 4.6 — no date suffix; this is the stable versioned ID for this model family)

The asymmetry in ID format is intentional — it reflects the actual Anthropic API model identifiers.

### Registered Prompts

| `prompt_id` | Default model | Purpose |
|---|---|---|
| `smart-reply-draft` | `haiku` | Draft 2–3 reply options for an inbound SMS conversation |
| `sequence-personalization` | `haiku` | Personalize a template message for a specific lead |
| `objection-handling` | `sonnet` | Suggest response strategies when coordinator flags an objection |
| `conversation-summary` | `haiku` | Summarize a long conversation thread into a 3-sentence briefing |
| `follow-up-timing` | `haiku` | Suggest optimal next follow-up timing based on lead behavior |
| `lead-scoring-commentary` | `haiku` | Explain why a lead is scored high or low |
| `conversation-reply-drafts` | `haiku` | Generate 2–3 draft reply options for a coordinator, given the full conversation thread and lead context. Used by Conversation Service for the AI draft strip above the composer. |
| `conversation-objection-handling` | `sonnet` | Suggest strategies for handling patient objections or concerns in an SMS conversation (e.g., cost concerns, scheduling hesitation). Returns structured suggestions. |
| `conversation-agent-reply` | `haiku` | Generate a single autonomous reply for AI Agent mode. Returns `{ text: string, escalate: boolean }` as JSON — `escalate: true` triggers human handoff. Parse failure by caller treated as escalation. |

**`conversation-agent-reply` structured output:** This prompt is designed to return a JSON object `{ "text": "<reply>", "escalate": <boolean> }`. The system prompt instructs the model to always respond in this JSON format. Conversation Service parses the response as JSON; any parse failure is treated as `escalate: true` (human handoff). The AI Service itself does not parse or validate the JSON — it returns the raw `text` string from Claude.

---

## 5. Response Cache

### Cache Key

`SHA256(prompt_id + ":" + resolved_model + ":" + canonicalized JSON(context))`

Context is serialized with recursively sorted keys before hashing — identical context objects with different key insertion order produce the same hash.

### Cache Flow

```
POST /ai/complete
  → resolve prompt definition (404 if not found)
  → resolve model (request override or prompt default)
  → compute cache_key
  → L1 in-memory hit? → return (cached: true)
  → L2 Postgres: SELECT WHERE cache_key = ? AND expires_at > NOW()
      HIT  → populate L1 → return (cached: true)
      MISS → call Claude API
           → INSERT ai_completions ON CONFLICT (cache_key)
               DO UPDATE SET response_text = EXCLUDED.response_text,
                             expires_at = EXCLUDED.expires_at
           → populate L1
           → return (cached: false)
```

The `ON CONFLICT` upsert handles the concurrent miss race — two ECS instances that simultaneously miss both cache layers both call Claude, but only one row is written; the second upserts harmlessly. Each caller always receives the response from its own Claude call (not the value stored in L2) — the L2 write is fire-and-forget after the Claude response is returned. Because LLM responses are non-deterministic, the two callers may receive slightly different `text` values. This is acceptable: the cache goal is cost efficiency and burst dedup, not strict response consistency. Once either response is written to L2, all subsequent callers within the TTL window receive that cached response.

**L1 eviction policy:** LRU with a maximum of 500 entries. TTL expiry (60s) is the primary eviction trigger; the 500-entry cap prevents unbounded memory growth under high load with many distinct cache keys.

### Lazy Cleanup

On every L2 write: `DELETE FROM ai_completions WHERE expires_at < NOW() - INTERVAL '1 hour'`

The 1-hour grace period beyond the 5-minute TTL is intentional — it avoids deleting rows that are technically expired but may still be race-read by a concurrent request that computed the cache key just before the DELETE ran. Expired rows are already excluded by the L2 SELECT (`expires_at > NOW()`), so they do not serve stale responses; the grace period simply avoids a cleanup/read race. Write frequency is low enough that inline cleanup is sufficient. No BullMQ job needed.

---

## 6. Data Model — `platform_ai`

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

```typescript
// src/index.ts (startup)
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { AnthropicInstrumentation } from '@arize-ai/openinference-instrumentation-anthropic';

registerInstrumentations({
  instrumentations: [new AnthropicInstrumentation()],
});
```

**Captured automatically per call:** input/output token counts, model ID, latency, full prompt (system + user after context injection), response text.

**Custom span attributes** added by `claude-client.ts` before each call:
- `prompt_id` — for filtering traces by feature in Phoenix UI
- `cached: false` — cache hits never reach `claude-client.ts`; only uncached calls are traced

**Configuration:** Phoenix endpoint set via env var `ARIZE_PHOENIX_ENDPOINT` (e.g. `http://phoenix.internal:6006`). If unset, instrumentation is a no-op — safe for local development without Phoenix running.

---

## 8. Infrastructure & Service Layout

```
apps/platform/ai/
├── src/
│   ├── routes/
│   │   └── complete.ts              # POST /ai/complete — validation, orchestration
│   ├── services/
│   │   ├── prompt-registry.ts       # Map<string, PromptDefinition>, loaded at startup
│   │   ├── context-injector.ts      # {{merge_tag}} substitution — pure function
│   │   ├── completion-cache.ts      # L1 in-memory + L2 Postgres, cache_key computation
│   │   └── claude-client.ts         # Anthropic SDK wrapper, Arize span attributes
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
│   │   └── completions.ts           # ai_completions table (platform_ai schema only)
│   └── index.ts                     # Fastify server, Arize Phoenix setup
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `platform_ai` schema)
- Claude API (Anthropic) — outbound HTTPS
- Arize Phoenix — outbound OTLP traces (`ARIZE_PHOENIX_ENDPOINT`)
- No Redis, no BullMQ, no EventBridge

---

## 9. Testing Strategy

### Unit Tests (Vitest)

Pure function coverage — no external dependencies:

- **Context injector:**
  - All tags present → correct substitution
  - Missing key → empty string, no throw
  - Dot-notation path: `{{lead.name}}`
  - Multiple occurrences of same tag all replaced
  - No tags in template → passthrough unchanged
  - Nested object paths resolved correctly

- **Prompt registry:**
  - Known `prompt_id` resolves to correct definition
  - Unknown `prompt_id` returns null

- **Cache key computation:**
  - Identical context objects with different key insertion order produce identical hash
  - Different context → different hash
  - Different `prompt_id` → different hash
  - Different resolved model → different hash

- **Model resolution:**
  - Explicit `model` field in request overrides prompt `defaultModel`
  - Absent `model` field uses prompt `defaultModel`
  - `"haiku"` maps to `claude-haiku-4-5-20251001` (the `-20251001` date suffix is part of the Anthropic API model ID)
  - `"sonnet"` maps to `claude-sonnet-4-6`

### Integration Tests (Vitest + real Postgres, Claude mocked via HTTP interceptor)

- Happy path → correct response returned, `cached: false`
- Unknown `prompt_id` → 404
- Missing `context` → 400
- Missing `prompt_id` → 400
- L1 cache hit → Claude not called, `cached: true`
- L2 cache hit (L1 cold) → Claude not called, `cached: true`, L1 populated for subsequent request
- Expired L2 entry (expires_at in past) → Claude called again, new entry written
- Concurrent identical requests → upsert handles race, no unique constraint error
- Claude returns 5xx → service returns 503
- Claude returns 429 (rate limit) → service returns 503
- Claude returns 529 (overload) → service returns 503
- Invalid `model` value (e.g. `"gpt-4"`) → 400
- Lazy cleanup: write with expired rows present → expired rows deleted after write

### Contract Tests

- **Outbound:** Claude API request shape — `model`, `system`, `messages[0].role`, `messages[0].content`, `max_tokens` match expected Anthropic SDK format
- **Inbound:** `POST /ai/complete` validates `prompt_id` is a non-empty string, `context` is an object

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Prompt storage | Static TypeScript files | Prompts are engineering artifacts — they need code review, testing, and git history, not a DB management UI. Changes deploy with the service. |
| Response cache | L1 in-memory 60s + L2 Postgres 5min | In-memory handles burst; Postgres handles cross-instance dedup without adding Redis as a new dependency to this service. |
| Cache idempotency | Content hash (`prompt_id + model + context`) | Natural dedup key — same inputs always produce the same hash, eliminating need for a caller-supplied dedup_key. |
| Concurrent miss handling | `ON CONFLICT DO UPDATE` upsert | Two instances missing simultaneously both call Claude; upsert prevents unique constraint errors and last writer wins harmlessly. |
| Lazy cache cleanup | Inline DELETE on write | Write frequency is low (only on cache misses). No BullMQ job needed. |
| Model routing | Caller override > prompt default | Each prompt defines its sensible default; callers (e.g. Automation Engine) can override per `call_ai` action for cost optimization. |
| Context injection syntax | `{{key}}` with dot-notation | Consistent with Template Service merge tag syntax — one pattern across all services. |
| Missing context keys | Empty string + log | Silent degradation — consistent with Template Service. A missing `{{first_name}}` produces "Hi !" rather than a 500. |
| Streaming | None | Not needed — coordinators receive full draft at once; Automation Engine workers are async (BullMQ). |
| Arize Phoenix | OpenInference SDK instrumentation at startup | Captures all Claude traces automatically without per-call code. `ARIZE_PHOENIX_ENDPOINT` unset → no-op. |
| No events published | None | AI Service is purely request/response. No state changes require downstream reaction. |
| AI Agent mode | Product layer (Conversation Service) | Stateful conversation management, escalation logic, and human handoff are Ortho CRM concerns — not platform-layer responsibilities. |
