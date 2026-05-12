# Automated QA Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a semi-autonomous QA pipeline that executes scenario-based tests against the running Ortho CRM stack, captures failures with Docker logs, and accumulates Vitest integration tests for passing scenarios.

**Architecture:** A Node.js/tsx runner (`qa/runner.ts`) reads `qa/scenarios.yaml`, executes HTTP and CLI steps against local services, writes structured JSON results to `qa/results/`. Claude Code orchestrates the loop: reads results, proposes code fixes, monitors service recovery via `qa/health-checker.ts`, and generates Vitest integration tests from passing scenarios.

**Tech Stack:** Node.js 24, TypeScript 5 (ESM, `"type": "module"`), tsx, js-yaml, Vitest 2, Docker Compose

---

## Task 1: Bootstrap `qa/` directory

**Files:**
- Create: `qa/package.json`
- Create: `qa/tsconfig.json`
- Create: `qa/vitest.config.ts`

- [ ] **Step 1: Create `qa/package.json`**

```json
{
  "name": "@ortho/qa",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "runner": "tsx runner.ts",
    "health": "tsx health-checker.ts"
  },
  "dependencies": {
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `qa/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*", "*.ts"]
}
```

- [ ] **Step 3: Create `qa/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Install dependencies**

```bash
cd qa && npm install
```

Expected: `node_modules/` created, `package-lock.json` created.

- [ ] **Step 5: Commit**

```bash
git add qa/package.json qa/tsconfig.json qa/vitest.config.ts qa/package-lock.json
git commit -m "feat(qa): bootstrap qa directory with package.json and tsconfig"
```

---

## Task 2: Service registry (`qa/services.yaml`)

**Files:**
- Create: `qa/services.yaml`

- [ ] **Step 1: Create `qa/services.yaml`**

```yaml
base_url: http://localhost

# supabase-auth is the GoTrue nginx proxy (rewrites /auth/v1/* → /*)
services:
  supabase-auth:   { port: 8000,  health: /health }
  identity:        { port: 3100,  health: /health }
  ai:              { port: 3101,  health: /health }
  template:        { port: 3102,  health: /health }
  notification:    { port: 3103,  health: /health }
  audience:        { port: 3104,  health: /health }
  analytics:       { port: 3105,  health: /health }
  messaging:       { port: 3106,  health: /health }
  email:           { port: 3107,  health: /health }
  nurturing:       { port: 3108,  health: /health }
  automation:      { port: 3109,  health: /health }
  integration-hub: { port: 3110,  health: /health }
  media:           { port: 3111,  health: /health }
  lead:            { port: 3200,  health: /health }
  pipeline:        { port: 3201,  health: /health }
  conversation:    { port: 3202,  health: /health }
  campaign:        { port: 3203,  health: /health }
  referral:        { port: 3204,  health: /health }
  reporting:       { port: 3205,  health: /health }
  import:          { port: 3206,  health: /health }
  crm-api-gateway: { port: 3207,  health: /health }
```

- [ ] **Step 2: Commit**

```bash
git add qa/services.yaml
git commit -m "feat(qa): add service registry"
```

---

## Task 3: Core TypeScript types (`qa/src/types.ts`)

**Files:**
- Create: `qa/src/types.ts`

- [ ] **Step 1: Create `qa/src/types.ts`**

```typescript
export interface ServiceConfig {
  port: number
  health: string
}

export interface ServicesFile {
  base_url: string
  services: Record<string, ServiceConfig>
}

export interface StepExpect {
  status?: number
  body_contains?: string[]
  exit_code?: number
  stdout_contains?: string
}

export interface HttpStep {
  type: 'http'
  service?: string        // overrides scenario-level service for URL resolution
  method: string
  path: string
  body?: Record<string, unknown>
  expect: StepExpect
  extract?: Record<string, string>  // varName → JSONPath (e.g. "$.id")
}

export interface CliStep {
  type: 'cli'
  command: string
  expect: StepExpect
  extract?: Record<string, string>  // applied to JSON-parsed stdout
}

export type Step = HttpStep | CliStep

export interface Scenario {
  id: string
  name: string
  service: string         // default service for docker log collection + http step URL
  depends_on?: string[]
  steps: Step[]
}

export interface ScenariosFile {
  scenarios: Scenario[]
}

export interface StepResult {
  index: number
  status: 'passed' | 'failed'
  actual: {
    status?: number
    body?: unknown
    stdout?: string
    stderr?: string
    exit_code?: number
  }
  expected: StepExpect
  docker_logs: string
  duration_ms: number
}

export interface ScenarioResult {
  id: string
  name: string
  status: 'passed' | 'failed' | 'skipped'
  failed_step?: number
  steps: StepResult[]
}

export interface RunResult {
  run_id: string
  summary: {
    total: number
    passed: number
    failed: number
    skipped: number
  }
  scenarios: ScenarioResult[]
}

export type RunContext = Record<string, string>
```

- [ ] **Step 2: Commit**

```bash
git add qa/src/types.ts
git commit -m "feat(qa): add core TypeScript types"
```

---

## Task 4: Utility functions — TDD (`qa/src/utils.ts`)

**Files:**
- Create: `qa/src/utils.test.ts`
- Create: `qa/src/utils.ts`

- [ ] **Step 1: Write failing tests (`qa/src/utils.test.ts`)**

```typescript
import { describe, it, expect } from 'vitest'
import { interpolate, interpolateObject, extractByPath, checkExpectation } from './utils.js'

describe('interpolate', () => {
  it('replaces {{var}} with context value', () => {
    expect(interpolate('Hello {{name}}!', { name: 'World' })).toBe('Hello World!')
  })

  it('replaces multiple occurrences of the same variable', () => {
    expect(interpolate('/leads/{{id}}/{{id}}', { id: 'abc' })).toBe('/leads/abc/abc')
  })

  it('replaces multiple different variables', () => {
    expect(interpolate('{{a}}-{{b}}', { a: 'x', b: 'y' })).toBe('x-y')
  })

  it('throws when variable not found in context', () => {
    expect(() => interpolate('{{missing}}', {})).toThrow("Variable 'missing' not found")
  })

  it('returns string unchanged when no placeholders', () => {
    expect(interpolate('/v1/leads', {})).toBe('/v1/leads')
  })
})

describe('interpolateObject', () => {
  it('interpolates string values in a flat object', () => {
    expect(interpolateObject({ id: '{{lead_id}}' }, { lead_id: 'abc123' }))
      .toEqual({ id: 'abc123' })
  })

  it('interpolates nested string values', () => {
    expect(interpolateObject({ nested: { key: '{{val}}' } }, { val: 'hello' }))
      .toEqual({ nested: { key: 'hello' } })
  })
})

describe('extractByPath', () => {
  it('extracts top-level key with $.key syntax', () => {
    expect(extractByPath({ id: 'abc123' }, '$.id')).toBe('abc123')
  })

  it('extracts nested key with $.a.b syntax', () => {
    expect(extractByPath({ data: { token: 'xyz' } }, '$.data.token')).toBe('xyz')
  })

  it('extracts value from array by index with $.data.0.id syntax', () => {
    expect(extractByPath({ data: [{ id: 'first' }, { id: 'second' }] }, '$.data.0.id')).toBe('first')
  })

  it('converts non-string values to string', () => {
    expect(extractByPath({ count: 42 }, '$.count')).toBe('42')
  })

  it('throws when path segment not found', () => {
    expect(() => extractByPath({ a: 1 }, '$.b')).toThrow("Path '$.b' not found")
  })

  it('throws when traversing into a non-object', () => {
    expect(() => extractByPath({ a: 'string' }, '$.a.nested')).toThrow()
  })
})

describe('checkExpectation', () => {
  it('passes when status matches', () => {
    expect(checkExpectation({ status: 200 }, { status: 200 }).passed).toBe(true)
  })

  it('fails when status mismatches', () => {
    const r = checkExpectation({ status: 500 }, { status: 201 })
    expect(r.passed).toBe(false)
    expect(r.reason).toContain('Expected status 201')
    expect(r.reason).toContain('got 500')
  })

  it('passes when all body_contains keys present in body', () => {
    const r = checkExpectation({ body: { id: '1', name: 'x' } }, { body_contains: ['id', 'name'] })
    expect(r.passed).toBe(true)
  })

  it('fails when body_contains key missing from body', () => {
    const r = checkExpectation({ body: { name: 'John' } }, { body_contains: ['id'] })
    expect(r.passed).toBe(false)
    expect(r.reason).toContain("'id'")
  })

  it('passes when exit_code matches', () => {
    expect(checkExpectation({ exit_code: 0 }, { exit_code: 0 }).passed).toBe(true)
  })

  it('fails when exit_code mismatches', () => {
    const r = checkExpectation({ exit_code: 1 }, { exit_code: 0 })
    expect(r.passed).toBe(false)
    expect(r.reason).toContain('exit code')
  })

  it('passes when stdout_contains substring present', () => {
    const r = checkExpectation({ stdout: 'Logged in successfully' }, { stdout_contains: 'Logged in' })
    expect(r.passed).toBe(true)
  })

  it('fails when stdout_contains substring absent', () => {
    const r = checkExpectation({ stdout: 'Error occurred' }, { stdout_contains: 'Logged in' })
    expect(r.passed).toBe(false)
  })

  it('passes when no expectations defined', () => {
    expect(checkExpectation({}, {}).passed).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd qa && npm test
```

Expected: tests fail with `Cannot find module './utils.js'`

- [ ] **Step 3: Implement `qa/src/utils.ts`**

```typescript
import type { StepExpect, RunContext } from './types.js'

export function interpolate(template: string, context: RunContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key in context) return context[key]
    throw new Error(
      `Variable '${key}' not found in context. Available: ${Object.keys(context).join(', ') || '(none)'}`
    )
  })
}

export function interpolateObject(obj: unknown, context: RunContext): unknown {
  return JSON.parse(interpolate(JSON.stringify(obj), context))
}

export function extractByPath(obj: unknown, path: string): string {
  const parts = path.replace(/^\$\./, '').split('.')
  let current: unknown = obj

  for (const part of parts) {
    if (current === null || current === undefined) {
      throw new Error(`Path '${path}' not found in object (null at '${part}')`)
    }
    if (Array.isArray(current)) {
      const index = parseInt(part, 10)
      if (isNaN(index)) {
        throw new Error(`Expected numeric array index at '${part}' in path '${path}'`)
      }
      current = current[index]
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part]
    } else {
      throw new Error(
        `Cannot traverse '${part}' — reached a primitive value before end of path '${path}'`
      )
    }
  }

  if (current === undefined) {
    throw new Error(`Path '${path}' not found in object`)
  }
  return String(current)
}

export function checkExpectation(
  actual: { status?: number; body?: unknown; stdout?: string; exit_code?: number },
  expect: StepExpect
): { passed: boolean; reason?: string } {
  if (expect.status !== undefined && actual.status !== expect.status) {
    return {
      passed: false,
      reason: `Expected status ${expect.status}, got ${actual.status}`,
    }
  }

  if (expect.body_contains !== undefined) {
    const bodyStr = JSON.stringify(actual.body ?? '')
    for (const key of expect.body_contains) {
      if (!bodyStr.includes(key)) {
        return {
          passed: false,
          reason: `Expected body to contain '${key}'. Body (truncated): ${bodyStr.slice(0, 300)}`,
        }
      }
    }
  }

  if (expect.exit_code !== undefined && actual.exit_code !== expect.exit_code) {
    return {
      passed: false,
      reason: `Expected exit code ${expect.exit_code}, got ${actual.exit_code}`,
    }
  }

  if (expect.stdout_contains !== undefined && actual.stdout !== undefined) {
    if (!actual.stdout.includes(expect.stdout_contains)) {
      return {
        passed: false,
        reason: `Expected stdout to contain '${expect.stdout_contains}'. Got: ${actual.stdout.slice(0, 200)}`,
      }
    }
  }

  return { passed: true }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd qa && npm test
```

Expected: all tests in `src/utils.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add qa/src/utils.ts qa/src/utils.test.ts
git commit -m "feat(qa): add and test utility functions (interpolate, extractByPath, checkExpectation)"
```

---

## Task 5: Dependency resolver — TDD (`qa/src/resolver.ts`)

**Files:**
- Create: `qa/src/resolver.test.ts`
- Create: `qa/src/resolver.ts`

- [ ] **Step 1: Write failing tests (`qa/src/resolver.test.ts`)**

```typescript
import { describe, it, expect } from 'vitest'
import { topologicalSort } from './resolver.js'
import type { Scenario } from './types.js'

function s(id: string, depends_on?: string[]): Scenario {
  return { id, name: id, service: 'test', steps: [], depends_on }
}

describe('topologicalSort', () => {
  it('returns single scenario unchanged', () => {
    const result = topologicalSort([s('a')])
    expect(result.map(x => x.id)).toEqual(['a'])
  })

  it('places dependency before dependent', () => {
    const result = topologicalSort([s('b', ['a']), s('a')])
    expect(result.map(x => x.id)).toEqual(['a', 'b'])
  })

  it('handles a chain: a → b → c', () => {
    const result = topologicalSort([s('c', ['b']), s('b', ['a']), s('a')])
    expect(result.map(x => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('handles diamond dependency: a → b, a → c, b+c → d', () => {
    const scenarios = [s('d', ['b', 'c']), s('b', ['a']), s('c', ['a']), s('a')]
    const result = topologicalSort(scenarios)
    const ids = result.map(x => x.id)
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'))
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'))
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'))
  })

  it('handles scenarios with no dependencies in any order', () => {
    const result = topologicalSort([s('x'), s('y'), s('z')])
    expect(result).toHaveLength(3)
  })

  it('throws on direct circular dependency', () => {
    expect(() => topologicalSort([s('a', ['b']), s('b', ['a'])])).toThrow('Circular dependency')
  })

  it('throws when depends_on references unknown scenario id', () => {
    expect(() => topologicalSort([s('a', ['does-not-exist'])])).toThrow('Unknown scenario')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd qa && npm test
```

Expected: tests fail with `Cannot find module './resolver.js'`

- [ ] **Step 3: Implement `qa/src/resolver.ts`**

```typescript
import type { Scenario } from './types.js'

export function topologicalSort(scenarios: Scenario[]): Scenario[] {
  const map = new Map(scenarios.map(s => [s.id, s]))
  const visited = new Set<string>()
  const result: Scenario[] = []

  function visit(id: string, chain: string[]): void {
    if (chain.includes(id)) {
      throw new Error(`Circular dependency detected: ${[...chain, id].join(' → ')}`)
    }
    if (visited.has(id)) return
    visited.add(id)

    const scenario = map.get(id)
    if (!scenario) {
      throw new Error(
        `Unknown scenario referenced in depends_on: '${id}'. ` +
        `Known ids: ${[...map.keys()].join(', ')}`
      )
    }

    for (const dep of scenario.depends_on ?? []) {
      visit(dep, [...chain, id])
    }
    result.push(scenario)
  }

  for (const s of scenarios) visit(s.id, [])
  return result
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd qa && npm test
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add qa/src/resolver.ts qa/src/resolver.test.ts
git commit -m "feat(qa): add and test topological sort for scenario dependency resolution"
```

---

## Task 6: Step executors (`qa/src/executors.ts`)

**Files:**
- Create: `qa/src/executors.ts`

Note: these functions perform real I/O (HTTP requests, child processes, Docker commands) so they are tested via the smoke test in Task 11, not with unit tests.

- [ ] **Step 1: Create `qa/src/executors.ts`**

```typescript
import { spawn } from 'child_process'
import { exec } from 'child_process'
import { promisify } from 'util'
import { interpolate, interpolateObject } from './utils.js'
import type { HttpStep, CliStep, RunContext } from './types.js'

const execAsync = promisify(exec)

export async function executeHttpStep(
  step: HttpStep,
  baseUrl: string,
  context: RunContext
): Promise<{ status: number; body: unknown }> {
  const path = interpolate(step.path, context)
  const url = `${baseUrl}${path}`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (context['token']) {
    headers['Authorization'] = `Bearer ${context['token']}`
  }

  const body = step.body
    ? JSON.stringify(interpolateObject(step.body, context))
    : undefined

  const res = await fetch(url, { method: step.method, headers, body })
  const responseBody = await res.json().catch(() => null)

  return { status: res.status, body: responseBody }
}

export async function executeCliStep(
  step: CliStep,
  context: RunContext
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const command = interpolate(step.command, context)

  return new Promise((resolve) => {
    const proc = spawn(command, [], { shell: true })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ stdout, stderr, exit_code: code ?? 1 }))
  })
}

export async function collectDockerLogs(service: string, projectRoot: string, seconds = 30): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `docker compose logs ${service} --since ${seconds}s --no-color 2>&1`,
      { cwd: projectRoot }
    )
    return stdout.slice(-4000)
  } catch {
    return ''
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add qa/src/executors.ts
git commit -m "feat(qa): add step executors (http, cli, docker logs)"
```

---

## Task 7: Runner main (`qa/runner.ts`)

**Files:**
- Create: `qa/runner.ts`

- [ ] **Step 1: Create `qa/runner.ts`**

```typescript
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, symlinkSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import { topologicalSort } from './src/resolver.js'
import { extractByPath, checkExpectation } from './src/utils.js'
import { executeHttpStep, executeCliStep, collectDockerLogs } from './src/executors.js'
import type {
  Scenario, ScenariosFile, ServicesFile, ServiceConfig,
  RunResult, ScenarioResult, StepResult, RunContext, Step,
} from './src/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '..')

function loadYaml<T>(path: string): T {
  return yaml.load(readFileSync(path, 'utf-8')) as T
}

function getBaseUrl(
  serviceName: string,
  services: Record<string, ServiceConfig>,
  baseUrl: string
): string {
  const svc = services[serviceName]
  if (!svc) {
    throw new Error(`Unknown service '${serviceName}'. Add it to services.yaml.`)
  }
  return `${baseUrl}:${svc.port}`
}

async function runScenario(
  scenario: Scenario,
  services: Record<string, ServiceConfig>,
  baseUrl: string,
  context: RunContext
): Promise<ScenarioResult> {
  const stepResults: StepResult[] = []
  let scenarioFailed = false

  for (let i = 0; i < scenario.steps.length; i++) {
    const step: Step = scenario.steps[i]
    const start = Date.now()
    let actual: StepResult['actual'] = {}
    let docker_logs = ''

    try {
      if (step.type === 'http') {
        const serviceForUrl = step.service ?? scenario.service
        const stepBaseUrl = getBaseUrl(serviceForUrl, services, baseUrl)
        const result = await executeHttpStep(step, stepBaseUrl, context)
        actual = { status: result.status, body: result.body }

        if (step.extract && result.body !== null) {
          for (const [varName, path] of Object.entries(step.extract)) {
            context[varName] = extractByPath(result.body, path)
          }
        }
      } else if (step.type === 'cli') {
        const result = await executeCliStep(step, context)
        actual = { stdout: result.stdout, stderr: result.stderr, exit_code: result.exit_code }

        if (step.extract && result.stdout.trim()) {
          try {
            const parsed = JSON.parse(result.stdout)
            for (const [varName, path] of Object.entries(step.extract)) {
              context[varName] = extractByPath(parsed, path)
            }
          } catch {
            // stdout not JSON — extraction skipped
          }
        }
      }

      docker_logs = await collectDockerLogs(scenario.service, PROJECT_ROOT)
    } catch (err: unknown) {
      docker_logs = await collectDockerLogs(scenario.service, PROJECT_ROOT)
      stepResults.push({
        index: i,
        status: 'failed',
        actual,
        expected: step.expect,
        docker_logs,
        duration_ms: Date.now() - start,
      })
      scenarioFailed = true
      break
    }

    const check = checkExpectation(actual, step.expect)
    stepResults.push({
      index: i,
      status: check.passed ? 'passed' : 'failed',
      actual,
      expected: step.expect,
      docker_logs,
      duration_ms: Date.now() - start,
    })

    if (!check.passed) {
      scenarioFailed = true
      break
    }
  }

  return {
    id: scenario.id,
    name: scenario.name,
    status: scenarioFailed ? 'failed' : 'passed',
    failed_step: scenarioFailed
      ? stepResults.findIndex(s => s.status === 'failed')
      : undefined,
    steps: stepResults,
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const scenarioIndex = args.indexOf('--scenario')
  const scenarioFilter = scenarioIndex !== -1 ? args[scenarioIndex + 1] : undefined

  const qaDir = __dirname
  const scenariosFile = loadYaml<ScenariosFile>(join(qaDir, 'scenarios.yaml'))
  const servicesFile = loadYaml<ServicesFile>(join(qaDir, 'services.yaml'))
  const { base_url, services } = servicesFile

  let scenarios = topologicalSort(scenariosFile.scenarios)

  if (scenarioFilter) {
    scenarios = scenarios.filter(s => s.id === scenarioFilter)
    if (scenarios.length === 0) {
      console.error(`No scenario found with id '${scenarioFilter}'`)
      process.exit(1)
    }
  }

  // Seed context with env vars for credentials
  const context: RunContext = {
    TEST_EMAIL: process.env['TEST_EMAIL'] ?? 'admin@test.com',
    TEST_PASSWORD: process.env['TEST_PASSWORD'] ?? 'password',
  }

  const results: ScenarioResult[] = []
  const failedIds = new Set<string>()
  const skippedIds = new Set<string>()

  for (const scenario of scenarios) {
    const depFailed = scenario.depends_on?.some(d => failedIds.has(d) || skippedIds.has(d))

    if (depFailed) {
      console.log(`  ⏭  ${scenario.name} (skipped — dependency failed)`)
      results.push({ id: scenario.id, name: scenario.name, status: 'skipped', steps: [] })
      skippedIds.add(scenario.id)
      continue
    }

    process.stdout.write(`  ▶  ${scenario.name} ... `)
    const result = await runScenario(scenario, services, base_url, context)
    results.push(result)

    if (result.status === 'failed') {
      console.log(`FAILED (step ${result.failed_step})`)
      failedIds.add(scenario.id)
    } else {
      console.log('PASSED')
    }
  }

  const summary = {
    total: results.length,
    passed: results.filter(r => r.status === 'passed').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
  }

  const runResult: RunResult = { run_id: new Date().toISOString(), summary, scenarios: results }

  const resultsDir = join(qaDir, 'results')
  mkdirSync(resultsDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = join(resultsDir, `${timestamp}.json`)
  writeFileSync(outFile, JSON.stringify(runResult, null, 2))

  const latestLink = join(resultsDir, 'latest.json')
  if (existsSync(latestLink)) unlinkSync(latestLink)
  symlinkSync(outFile, latestLink)

  console.log(`\n  Total: ${summary.total}  Passed: ${summary.passed}  Failed: ${summary.failed}  Skipped: ${summary.skipped}`)
  console.log(`  Results written to: ${outFile}`)

  process.exit(summary.failed > 0 ? 1 : 0)
}

main().catch((err: unknown) => {
  console.error('Runner crashed:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd qa && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add qa/runner.ts
git commit -m "feat(qa): add QA runner main entry point"
```

---

## Task 8: Health checker (`qa/health-checker.ts`)

**Files:**
- Create: `qa/health-checker.ts`

- [ ] **Step 1: Create `qa/health-checker.ts`**

```typescript
#!/usr/bin/env node
import { readFileSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import type { ServicesFile, ServiceConfig } from './src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const POLL_INTERVAL_MS = 5_000
const TIMEOUT_MS = 3 * 60 * 1_000

async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
    return res.ok
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const allFlag = args.includes('--all')
  const serviceIdx = args.indexOf('--service')
  const serviceFlag = serviceIdx !== -1 ? args[serviceIdx + 1] : undefined

  if (!allFlag && !serviceFlag) {
    console.error('Usage: npx tsx qa/health-checker.ts --service <name> | --all')
    process.exit(1)
  }

  const qaDir = __dirname
  const servicesFile = yaml.load(
    readFileSync(join(qaDir, 'services.yaml'), 'utf-8')
  ) as ServicesFile
  const { base_url, services } = servicesFile

  let targets: Array<[string, ServiceConfig]>

  if (allFlag) {
    targets = Object.entries(services)
  } else {
    if (!services[serviceFlag!]) {
      console.error(`Unknown service: '${serviceFlag}'. Check qa/services.yaml.`)
      process.exit(1)
    }
    targets = [[serviceFlag!, services[serviceFlag!]]]
  }

  const deadline = Date.now() + TIMEOUT_MS
  const healthy = new Set<string>()

  console.log(`Waiting for ${targets.length} service(s) to become healthy (timeout: 3 min)...`)

  while (Date.now() < deadline) {
    for (const [name, config] of targets) {
      if (healthy.has(name)) continue
      const url = `${base_url}:${config.port}${config.health}`
      if (await isHealthy(url)) {
        healthy.add(name)
        console.log(`  ✓ ${name} healthy`)
      }
    }

    if (healthy.size === targets.length) {
      console.log('All targeted services are healthy.')
      process.exit(0)
    }

    const remaining = targets.filter(([n]) => !healthy.has(n)).map(([n]) => n)
    process.stdout.write(`  Still waiting: ${remaining.join(', ')}...\r`)
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }

  const stuck = targets.filter(([n]) => !healthy.has(n)).map(([n]) => n)
  console.error(`\nTimeout: services still unhealthy after 3 min: ${stuck.join(', ')}`)
  process.exit(1)
}

main().catch((err: unknown) => {
  console.error('health-checker crashed:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd qa && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add qa/health-checker.ts
git commit -m "feat(qa): add health checker with polling and timeout"
```

---

## Task 9: Initial scenario catalog (`qa/scenarios.yaml`)

**Files:**
- Create: `qa/scenarios.yaml`

Auth flow: the runner performs a 2-step HTTP auth (GoTrue at port 8000, then Identity Service at port 3100) and stores the CRM JWT as `{{token}}` in context. All subsequent HTTP steps automatically include `Authorization: Bearer {{token}}`.

- [ ] **Step 1: Create `qa/scenarios.yaml`**

```yaml
# QA Scenario Catalog
# Source of truth for what gets tested. Edit freely — Claude generates the initial list,
# you own it from here. Add scenarios as features are tested and confirmed working.
#
# Auth credentials: set TEST_EMAIL and TEST_PASSWORD env vars, or defaults are used.
# Defaults: admin@test.com / password

scenarios:

  # ── Authentication ─────────────────────────────────────────────────────────
  # Two-step auth: GoTrue (port 8000) → Identity Service (port 3100)
  # On success, puts {{token}} in context for all subsequent HTTP steps.
  - id: auth-login
    name: "Auth: get CRM JWT"
    service: identity
    steps:
      - type: http
        service: supabase-auth
        method: POST
        path: /auth/v1/token?grant_type=password
        body:
          email: "{{TEST_EMAIL}}"
          password: "{{TEST_PASSWORD}}"
        expect:
          status: 200
          body_contains: ["access_token"]
        extract:
          provider_token: "$.access_token"

      - type: http
        service: identity
        method: POST
        path: /identity/session
        body:
          provider_token: "{{provider_token}}"
        expect:
          status: 200
          body_contains: ["access_token"]
        extract:
          token: "$.access_token"

  # ── Locations ──────────────────────────────────────────────────────────────
  - id: location-create
    name: "Locations: create"
    service: identity
    depends_on: [auth-login]
    steps:
      - type: http
        method: POST
        path: /v1/locations
        body:
          name: "QA Test Location"
          address: "123 QA Street"
          city: "Austin"
          state: "TX"
          zip: "78701"
          phone: "+15551234567"
          timezone: "America/Chicago"
        expect:
          status: 201
          body_contains: ["id", "name"]
        extract:
          location_id: "$.id"

  - id: location-list
    name: "Locations: list"
    service: identity
    depends_on: [auth-login]
    steps:
      - type: http
        method: GET
        path: /v1/locations
        expect:
          status: 200
          body_contains: ["data"]

  - id: location-get
    name: "Locations: get by id"
    service: identity
    depends_on: [location-create]
    steps:
      - type: http
        method: GET
        path: /v1/locations/{{location_id}}
        expect:
          status: 200
          body_contains: ["id", "name"]

  # ── Leads ──────────────────────────────────────────────────────────────────
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
          last_name: "Test"
          phone: "+15559876543"
          email: "qa.test@example.com"
          source: "website"
          location_id: "{{location_id}}"
        expect:
          status: 201
          body_contains: ["id", "first_name"]
        extract:
          lead_id: "$.id"

  - id: lead-get
    name: "Leads: get by id"
    service: crm-api-gateway
    depends_on: [lead-create]
    steps:
      - type: http
        method: GET
        path: /v1/leads/{{lead_id}}
        expect:
          status: 200
          body_contains: ["id", "first_name", "last_name"]

  - id: lead-list
    name: "Leads: list with pagination"
    service: crm-api-gateway
    depends_on: [auth-login]
    steps:
      - type: http
        method: GET
        path: /v1/leads?page=1&limit=10
        expect:
          status: 200
          body_contains: ["data", "total"]

  - id: lead-update
    name: "Leads: update"
    service: crm-api-gateway
    depends_on: [lead-create]
    steps:
      - type: http
        method: PATCH
        path: /v1/leads/{{lead_id}}
        body:
          first_name: "UpdatedQA"
        expect:
          status: 200
          body_contains: ["id"]

  # ── Pipeline ───────────────────────────────────────────────────────────────
  - id: pipeline-lead-state
    name: "Pipeline: get lead's pipeline state"
    service: crm-api-gateway
    depends_on: [lead-create]
    steps:
      - type: http
        method: GET
        path: /v1/pipeline/leads/{{lead_id}}
        expect:
          status: 200
          body_contains: ["stage"]
```

- [ ] **Step 2: Verify runner can parse the file**

```bash
cd qa && npx tsx runner.ts --scenario auth-login
```

Expected: runner starts and attempts to connect to supabase-auth at `http://localhost:8000`. If the stack is not running you'll see a connection error — that is expected at this stage. What you should NOT see is a YAML parse error or TypeScript error.

- [ ] **Step 3: Commit**

```bash
git add qa/scenarios.yaml
git commit -m "feat(qa): add initial scenario catalog (auth, locations, leads, pipeline)"
```

---

## Task 10: QA Claude skill (`.claude/skills/qa.md`)

**Files:**
- Create: `.claude/skills/qa.md`

This skill is invoked with `/qa` in Claude Code. It instructs Claude to act as the QA orchestrator.

- [ ] **Step 1: Create `.claude/skills/qa.md`**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/qa.md
git commit -m "feat(qa): add /qa Claude orchestrator skill"
```

---

## Task 11: Smoke test the full pipeline

Prerequisite: Docker Compose stack is running (`./scripts/dev/up-all.sh` or equivalent). A user account with known credentials exists in the system.

- [ ] **Step 1: Set credentials and run a single scenario**

```bash
export TEST_EMAIL=your-test-email@example.com
export TEST_PASSWORD=your-test-password
cd qa && npx tsx runner.ts --scenario auth-login
```

Expected: runner executes both HTTP steps and prints `PASSED`. `qa/results/latest.json` exists.

- [ ] **Step 2: Run the full suite**

```bash
cd qa && npx tsx runner.ts
```

Expected: runner executes all scenarios in dependency order, printing pass/fail for each. Results written to `qa/results/`.

- [ ] **Step 3: Test the health checker against a running service**

```bash
cd qa && npx tsx health-checker.ts --service crm-api-gateway
```

Expected: immediately prints `✓ crm-api-gateway healthy` and exits 0 (service is already up).

- [ ] **Step 4: Commit gitignored results directory**

Add `qa/results/` and `qa/bugs/` to `.gitignore` (runtime output, not source):

```bash
echo "qa/results/" >> .gitignore
echo "qa/bugs/" >> .gitignore
git add .gitignore
git commit -m "chore: gitignore qa runtime output directories"
```

- [ ] **Step 5: Run unit tests one final time to confirm nothing broke**

```bash
cd qa && npm test
```

Expected: all unit tests pass (utils + resolver).

---

## Notes for the implementer

**Test credentials:** Create a test user in the local Supabase instance before running. The GoTrue admin API is at `http://localhost:9999`. Alternatively, check if a seed script exists in `scripts/dev/`.

**Scenario isolation:** Each QA run creates new test data (locations, leads). In a dev environment this is acceptable. If the database gets noisy, run `./scripts/dev/reset.sh` to wipe and restart.

**Adding new scenarios:** Add a new entry to `qa/scenarios.yaml`. The runner picks it up on the next run — no code changes needed.

**GoTrue `/health` endpoint:** The supabase-auth proxy may not have a `/health` route. If `health-checker.ts --all` fails for `supabase-auth`, update its health path in `services.yaml` to a known-good path (e.g. `/auth/v1/health`) or remove it from `--all` checks.
