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
