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
