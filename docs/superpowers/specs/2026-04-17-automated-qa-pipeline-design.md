# Automated QA Pipeline — Design Spec

**Status:** Approved  
**Date:** 2026-04-17  
**Scope:** Semi-autonomous scenario-based QA pipeline for Ortho CRM (20 services)

---

## 1. Problem

Testing 20 microservices manually is slow and error-prone. The current workflow (run CLI → check logs → paste error to Claude → fix → rebuild → retest) is unstructured, non-reproducible, and produces no lasting test artifacts. As the product grows, this approach does not scale.

## 2. Goals

- Structured, reproducible scenario execution across all services
- Semi-autonomous bug detection: agent finds and proposes fixes, human approves
- Growing library of Vitest integration tests as a by-product of QA runs
- CI/CD-ready test suite that runs without Claude

## 3. Non-Goals

- Fully autonomous fix-and-deploy without human approval
- Unit test generation (unit tests are written during feature development)
- Load or performance testing
- Testing services that are not running locally via Docker Compose

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Orchestrator                       │
│  (Claude Code session — runs scripts, reads results, fixes) │
└──────┬─────────────────────────────────────┬────────────────┘
       │ runs                                 │ reads
       ▼                                      ▼
┌─────────────┐    writes    ┌──────────────────────────────┐
│  QA Runner  │ ──────────── │  qa/results/YYYY-MM-DD.json  │
│ (runner.ts) │              └──────────────────────────────┘
└─────────────┘
       │ reads                         │ on failure
       ▼                               ▼
┌──────────────┐          ┌────────────────────────────┐
│ scenarios.yaml│          │  qa/bugs/bug-NNN.md         │
│  (catalog)   │          │  + Push Notification        │
└──────────────┘          └────────────────────────────┘
                                       │ after fix approved
                                       ▼
                          ┌────────────────────────────┐
                          │  health-checker.ts          │
                          │  (polls /health endpoints)  │
                          └────────────────────────────┘
                                       │ services healthy
                                       ▼
                          ┌────────────────────────────┐
                          │  Retest scenario            │
                          │  → generate Vitest test     │
                          └────────────────────────────┘
```

### File Structure

```
qa/
├── scenarios.yaml            ← scenario catalog (source of truth)
├── services.yaml             ← service registry (name → port/health)
├── runner.ts                 ← executes scenarios, writes results JSON
├── health-checker.ts         ← polls /health until service is up
├── results/                  ← JSON output from each run
│   └── YYYY-MM-DD-HH-MM-SS.json
└── bugs/                     ← markdown bug reports
    └── bug-NNN.md
```

Generated Vitest tests are placed in the relevant service:
- Cross-service / API Gateway scenarios → `apps/crm/api-gateway/test/integration/e2e/`
- Single-service scenarios → `apps/<layer>/<service>/test/integration/e2e/`

---

## 5. Scenario Catalog (`qa/scenarios.yaml`)

The catalog is the single source of truth for what gets tested. Claude generates the initial version from architecture docs and specs; the user reviews and edits it before the first run.

```yaml
scenarios:
  - id: auth-login
    name: "Login"
    service: identity
    steps:
      - type: cli
        command: crm login --email admin@test.com --password secret
        expect:
          exit_code: 0
          stdout_contains: "Logged in successfully"

  - id: location-list
    name: "List locations"
    service: identity
    depends_on: [auth-login]
    steps:
      - type: http
        method: GET
        path: /v1/locations
        expect:
          status: 200
          body_contains: ["data"]

  - id: lead-create
    name: "Create lead"
    service: crm-api-gateway
    depends_on: [auth-login, location-list]
    steps:
      - type: http
        method: POST
        path: /v1/leads
        body:
          first_name: "John"
          last_name: "Doe"
          phone: "+15551234567"
          source: "website"
          location_id: "{{location_id}}"
        expect:
          status: 201
          body_contains: ["id", "first_name"]
        extract:
          lead_id: "$.id"
      - type: http
        method: GET
        path: /v1/leads/{{lead_id}}
        expect:
          status: 200

  - id: lead-list
    name: "List leads"
    service: crm-api-gateway
    depends_on: [lead-create]
    steps:
      - type: http
        method: GET
        path: /v1/leads?page=1&limit=10
        expect:
          status: 200
          body_contains: ["data", "total"]
```

**Step types:**
- `cli` — spawns `crm` CLI, captures stdout/stderr and exit code
- `http` — sends HTTP request to `http://localhost:<port>` where port comes from the scenario's `service` field in `services.yaml`; captures status and body

**`extract`:** a map of `variable_name → JSONPath expression` applied to the response body. Extracted values are added to the run context and available as `{{variable}}` in subsequent steps. Example: `lead_id: "$.id"` extracts `response.body.id` into `{{lead_id}}`.

**Variable interpolation:** `{{variable}}` values come from the context built up by previous steps. The context is initialized with a `token` from `auth-login` and `location_id` from `location-list`.

**`depends_on`:** if a dependency scenario has failed or was skipped, this scenario is skipped (not marked failed). This prevents cascading failures.

---

## 6. Service Registry (`qa/services.yaml`)

```yaml
base_url: http://localhost

services:
  identity:        { port: 3100, health: /health }
  ai:              { port: 3101, health: /health }
  template:        { port: 3102, health: /health }
  notification:    { port: 3103, health: /health }
  audience:        { port: 3104, health: /health }
  analytics:       { port: 3105, health: /health }
  messaging:       { port: 3106, health: /health }
  email:           { port: 3107, health: /health }
  nurturing:       { port: 3108, health: /health }
  automation:      { port: 3109, health: /health }
  integration-hub: { port: 3110, health: /health }
  media:           { port: 3111, health: /health }
  lead:            { port: 3200, health: /health }
  pipeline:        { port: 3201, health: /health }
  conversation:    { port: 3202, health: /health }
  campaign:        { port: 3203, health: /health }
  referral:        { port: 3204, health: /health }
  reporting:       { port: 3205, health: /health }
  import:          { port: 3206, health: /health }
  crm-api-gateway: { port: 3207, health: /health }
```

---

## 7. QA Runner (`qa/runner.ts`)

A standalone Node.js/tsx script. Does mechanical work only — no interpretation.

**Execution flow:**
1. Parse `scenarios.yaml` and `services.yaml`
2. Build dependency graph; topologically sort scenarios
3. For each scenario (in order):
   a. Skip if any dependency failed or was skipped
   b. Execute each step sequentially, interpolating `{{variables}}` from context
   c. After each step: collect docker logs for the scenario's `service` (`docker compose logs <service> --since 30s --no-color`)
   d. Compare actual vs expected; mark step passed/failed
   e. On first failed step: stop this scenario, record failure details
4. Write full results to `qa/results/<timestamp>.json` and symlink to `qa/results/latest.json`
5. Exit with code 0 if all passed, 1 if any failed

**Result schema:**
```json
{
  "run_id": "2026-04-17T10:30:00.000Z",
  "summary": { "total": 15, "passed": 12, "failed": 2, "skipped": 1 },
  "scenarios": [
    {
      "id": "lead-create",
      "name": "Create lead",
      "status": "failed",
      "failed_step": 0,
      "steps": [
        {
          "index": 0,
          "status": "failed",
          "actual": { "status": 500, "body": { "error": "column 'location_id' does not exist" } },
          "expected": { "status": 201 },
          "docker_logs": "...",
          "duration_ms": 342
        }
      ]
    }
  ]
}
```

---

## 8. Health Checker (`qa/health-checker.ts`)

Invoked by Claude Orchestrator after the user triggers a service rebuild.

```
Usage:
  npx tsx qa/health-checker.ts --service crm-api-gateway
  npx tsx qa/health-checker.ts --all
```

**Logic:**
- Reads service registry from `services.yaml`
- Every 5 seconds: `GET http://localhost:<port><health_path>`
- Service considered healthy on `200 OK`
- Timeout: 3 minutes — exits with code 1 and prints which services are still unhealthy
- Exits with code 0 when all targeted services are healthy
- Claude reads the exit code to decide whether to proceed with retest or report a startup failure

---

## 9. Claude Orchestrator Flow

Claude Code acts as the orchestrator within a session. The full cycle:

```
1. RUN
   └─ npx tsx qa/runner.ts [--scenario <id>]
   └─ reads qa/results/latest.json

2. ANALYZE
   ├─ all passed → generate Vitest tests for uncovered scenarios → done
   └─ failures found →
       ├─ reads docker_logs from results JSON
       ├─ reads source code of the failing service
       ├─ identifies root cause
       └─ writes qa/bugs/bug-NNN.md

3. BUG REPORT (qa/bugs/bug-NNN.md)
   ├─ which scenario failed and at which step
   ├─ expected vs actual (status, body)
   ├─ root cause (derived from logs + source code)
   └─ proposed fix (prose description + exact code diff)

4. NOTIFY
   └─ PushNotification: "Bug found in [scenario-name]. Report: qa/bugs/bug-NNN.md"

5. WAIT
   └─ pauses and waits for: "apply fix" / "skip" / "stop"

6. APPLY FIX
   ├─ edits service source files
   └─ outputs: "Done. Rebuild with: docker compose up --build <service> -d"

7. WATCH RECOVERY
   └─ npx tsx qa/health-checker.ts --service <service>
      polls every 5s, timeout 3 min

8. RETEST
   └─ npx tsx qa/runner.ts --scenario <id>
   ├─ passed → generate Vitest test → move to next failed scenario
   └─ failed → repeat from step 2
```

---

## 10. Vitest Test Generation

When a scenario passes (either on first run or after a fix), Claude generates a Vitest integration test from the scenario definition and the actual captured responses.

**Conventions:**
- File: `test/integration/e2e/<scenario-id>.test.ts` in the relevant service directory
- Uses `fetch()` directly against the running service (no mocks)
- `beforeAll` handles auth token acquisition if the scenario depends on `auth-login`
- Variables captured between steps are threaded through test state
- Tests are standalone: each file sets up its own prerequisites

**Example output for `lead-create`:**
```typescript
// apps/crm/api-gateway/test/integration/e2e/lead-create.test.ts
import { describe, it, expect, beforeAll } from 'vitest'

const BASE = process.env.API_GATEWAY_URL ?? 'http://localhost:3207'
let token: string
let leadId: string

beforeAll(async () => {
  const res = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.com', password: 'secret' })
  })
  token = (await res.json()).access_token
})

describe('POST /v1/leads', () => {
  it('creates a lead', async () => {
    const res = await fetch(`${BASE}/v1/leads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ first_name: 'John', last_name: 'Doe', phone: '+15551234567', source: 'website' })
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toHaveProperty('id')
    leadId = body.id
  })

  it('retrieves the created lead', async () => {
    const res = await fetch(`${BASE}/v1/leads/${leadId}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(res.status).toBe(200)
  })
})
```

Generated tests are committed alongside the service source. They run with `npm run test` in the service directory and are picked up by the existing Vitest configuration.

---

## 11. Component Summary

| Component | File | Author | Purpose |
|---|---|---|---|
| Scenario catalog | `qa/scenarios.yaml` | Claude generates, human edits | Source of truth for what gets tested |
| Service registry | `qa/services.yaml` | Generated once | Port/health mapping for all 20 services |
| Test runner | `qa/runner.ts` | Claude builds | Mechanical scenario execution |
| Health checker | `qa/health-checker.ts` | Claude builds | Detects service recovery after rebuild |
| Bug reports | `qa/bugs/bug-NNN.md` | Claude writes | Structured failure + fix proposal |
| Vitest E2E tests | `test/integration/e2e/*.test.ts` | Claude generates | Permanent CI-ready test artifacts |

---

## 12. Rollout Order

1. Build `qa/services.yaml` (20 service entries)
2. Build `qa/runner.ts` + `qa/health-checker.ts`
3. Generate initial `qa/scenarios.yaml` from arch docs — human reviews
4. Run first QA cycle manually; fix failures; generate first Vitest tests
5. Expand scenario catalog to cover all major feature areas
6. Add `npm run test:e2e` script to each service that runs `test/integration/e2e/`
