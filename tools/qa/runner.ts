#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, symlinkSync, lstatSync } from 'fs'
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
const PROJECT_ROOT = resolve(__dirname, '..', '..')

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
  try { lstatSync(latestLink); unlinkSync(latestLink) } catch { /* doesn't exist */ }
  symlinkSync(outFile, latestLink)

  console.log(`\n  Total: ${summary.total}  Passed: ${summary.passed}  Failed: ${summary.failed}  Skipped: ${summary.skipped}`)
  console.log(`  Results written to: ${outFile}`)

  process.exit(summary.failed > 0 ? 1 : 0)
}

main().catch((err: unknown) => {
  console.error('Runner crashed:', err)
  process.exit(1)
})
