# QA Orchestrator

Run the QA scenario pipeline and orchestrate the fix-retest loop.

## How to start a QA run

1. Run the scenario runner:
   ```bash
   cd qa && npx tsx runner.ts
   ```
   Or to run a single scenario:
   ```bash
   cd qa && npx tsx runner.ts --scenario <scenario-id>
   ```

2. Read the results from `qa/results/latest.json`.

## When all scenarios pass

For each passing scenario that does not yet have a Vitest integration test in `test/integration/e2e/`:
- Generate the test file based on the scenario definition and the actual captured responses.
- Place it in the service's test directory: `apps/<layer>/<service>/test/integration/e2e/<scenario-id>.test.ts`
- Cross-service / API Gateway scenarios go to: `apps/crm/api-gateway/test/integration/e2e/<scenario-id>.test.ts`

Test conventions:
- Import from `vitest`, use `fetch()` with `process.env.API_GATEWAY_URL ?? 'http://localhost:3207'`
- `beforeAll` acquires auth token if the scenario depends on auth-login
- Thread scenario variables (e.g. `lead_id`) through test state using `let` variables
- Each test file is standalone — sets up its own prerequisites

## When a scenario fails

1. Read `qa/results/latest.json` — find the failed scenario and its `docker_logs`.
2. Read the source code of the failing service (check the `service` field in the scenario).
3. Identify the root cause from the logs + code.
4. Write a bug report to `qa/bugs/bug-NNN.md` with this structure:
   ```
   # Bug NNN: <scenario-name> — <short description>
   **Scenario:** <id>
   **Step:** <index>
   **Expected:** <status/body>
   **Actual:** <status/body>
   **Docker logs:** (relevant excerpt)
   **Root cause:** (explanation)
   **Proposed fix:** (prose + code diff)
   ```
5. Send a push notification: "Bug found in [scenario-name]. Fix ready in qa/bugs/bug-NNN.md"
6. Wait for the user to say "apply fix" / "skip" / "stop".

## When the user says "apply fix"

1. Apply the code changes from the bug report.
2. Tell the user: "Done. Rebuild with: `docker compose up --build <service-name> -d`"
3. Run health checker and wait for the service to recover:
   ```bash
   cd qa && npx tsx health-checker.ts --service <service-name>
   ```
4. When health checker exits 0, rerun the failed scenario:
   ```bash
   cd qa && npx tsx runner.ts --scenario <scenario-id>
   ```
5. If it passes — generate the Vitest test and move to the next failed scenario.
6. If it still fails — go back to step 1 (re-analyze with updated logs).

## When the user says "skip"

Mark the scenario as known-failing (add a comment to `qa/scenarios.yaml`) and continue with the next failing scenario.

## When the user says "stop"

Summarize: how many passed, how many failed, which bug reports were written.
