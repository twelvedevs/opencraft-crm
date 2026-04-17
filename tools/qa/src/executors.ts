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
