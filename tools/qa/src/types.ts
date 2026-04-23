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
  include?: string[]
  scenarios?: Scenario[]
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
