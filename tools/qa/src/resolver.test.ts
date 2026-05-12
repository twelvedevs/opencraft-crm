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
