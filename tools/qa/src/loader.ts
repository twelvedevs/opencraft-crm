import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import yaml from 'js-yaml'
import type { Scenario, ScenariosFile } from './types.js'

export function loadScenarios(filePath: string): Scenario[] {
  const scenarios = collect(resolve(filePath), new Set())

  const seen = new Set<string>()
  for (const s of scenarios) {
    if (seen.has(s.id)) {
      throw new Error(`Duplicate scenario id '${s.id}'`)
    }
    seen.add(s.id)
  }

  return scenarios
}

function collect(absPath: string, visited: Set<string>): Scenario[] {
  if (visited.has(absPath)) return []
  visited.add(absPath)

  const raw = yaml.load(readFileSync(absPath, 'utf-8')) as ScenariosFile
  const result: Scenario[] = []

  for (const includePath of raw.include ?? []) {
    result.push(...collect(resolve(dirname(absPath), includePath), visited))
  }

  result.push(...(raw.scenarios ?? []))
  return result
}
