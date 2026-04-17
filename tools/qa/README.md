# QA Pipeline

Semi-autonomous QA harness that executes scenario-based tests against the running Ortho CRM stack, captures failures with Docker logs, and accumulates Vitest integration tests for passing scenarios.

The runner reads `scenarios.yaml`, executes HTTP and CLI steps against local services, and writes structured JSON results to `results/`. Claude Code orchestrates the loop via the `/qa` skill: reading results, proposing fixes, monitoring service recovery via `health-checker.ts`, and generating Vitest tests from passing scenarios.

## Prerequisites

- Node.js 24+
- CRM stack running: `./scripts/dev/up-all.sh` (or at minimum the services a scenario touches)
- A test user in the local Supabase instance (see **Test credentials** below)

## Install

```bash
cd tools/qa
npm install
```

## Running

```bash
# Full suite (dependency-ordered)
npx tsx runner.ts

# Single scenario
npx tsx runner.ts --scenario auth-login

# Wait for a service to recover after rebuild
npx tsx health-checker.ts --service crm-api-gateway
npx tsx health-checker.ts --all

# Unit tests for the runner itself
npm test
```

Results land in `results/<timestamp>.json` with `results/latest.json` symlinked to the most recent run. The directory is git-ignored.

## Test credentials

The runner seeds auth via `TEST_EMAIL` / `TEST_PASSWORD` env vars (defaults: `admin@test.com` / `password`):

```bash
export TEST_EMAIL=your-test-email@example.com
export TEST_PASSWORD=your-test-password
npx tsx runner.ts
```

Create the user in local Supabase (GoTrue admin API at `http://localhost:9999`) or via a seed script in `scripts/dev/` before the first run.

## Authoring scenarios

Scenarios live in `scenarios.yaml`. A scenario has an `id`, `service` (for Docker log collection + default HTTP target), optional `depends_on`, and an ordered list of steps:

```yaml
- id: lead-create
  name: "Leads: create"
  service: crm-api-gateway
  depends_on: [auth-login, location-create]
  steps:
    - type: http
      method: POST
      path: /v1/leads
      body:
        first_name: "QA"
        location_id: "{{location_id}}"
      expect:
        status: 201
        body_contains: ["id"]
      extract:
        lead_id: "$.id"
```

**Step types:**
- `http` — `method`, `path`, optional `body`, `expect { status, body_contains[] }`, optional `extract { varName: "$.json.path" }`. A step may set `service:` to override the scenario-level target (used for cross-service flows like auth).
- `cli` — `command`, `expect { exit_code, stdout_contains }`, optional `extract` applied to JSON-parsed stdout.

**Variable flow:**
- Context seeds with `TEST_EMAIL` / `TEST_PASSWORD`.
- `auth-login` extracts `{{token}}`; every subsequent HTTP step automatically adds `Authorization: Bearer {{token}}`.
- `{{var}}` placeholders in `path`, `body`, and `command` interpolate from context.

**Dependency ordering:**
- `depends_on` is a topological hint. The runner sorts before executing and skips any scenario whose deps failed or were skipped.

## Adding a new service target

Edit `services.yaml`:

```yaml
services:
  my-new-service: { port: 3210, health: /health }
```

Then reference it via the scenario `service:` field (or per-step `service:` override).

## Orchestration with Claude Code

Use the `/qa` slash skill — `.claude/skills/qa.md`. The skill instructs Claude to:

1. Run the scenario suite.
2. On failures — read `results/latest.json`, inspect the offending service's source, write a bug report to `bugs/bug-NNN.md`, and pause for `apply fix` / `skip` / `stop`.
3. On `apply fix` — apply the diff, wait for health, rerun the failed scenario.
4. On pass — generate a Vitest integration test under the service's `test/integration/e2e/` directory.

`bugs/` is git-ignored runtime output.

## Architecture

```
tools/qa/
├── runner.ts              # CLI entry — loads yaml, topological sort, executes, writes results
├── health-checker.ts      # Polls /health endpoints until ready or 3-min timeout
├── scenarios.yaml         # Source of truth for what gets tested
├── services.yaml          # Service → port/health registry
├── src/
│   ├── types.ts           # TypeScript contracts
│   ├── resolver.ts        # Topological sort (unit-tested)
│   ├── utils.ts           # interpolate / extractByPath / checkExpectation (unit-tested)
│   └── executors.ts       # HTTP + CLI + docker logs step executors
├── results/               # Runtime output (git-ignored) — JSON per run + latest.json symlink
└── bugs/                  # Claude-generated bug reports (git-ignored)
```

## Notes

- **Scenario isolation:** each run creates new test data (locations, leads). Run `./scripts/dev/reset.sh` to wipe the DB if it gets noisy.
- **GoTrue `/health`:** the supabase-auth nginx proxy may not expose `/health` at the root. If `health-checker.ts --all` fails on `supabase-auth`, change its `health` path in `services.yaml` to a known-good route (e.g. `/auth/v1/health`) or exclude it from `--all` checks.
- **Docker logs:** captured via `docker compose logs <service> --since 30s` from the repo root, truncated to the last 4 KB per step.
