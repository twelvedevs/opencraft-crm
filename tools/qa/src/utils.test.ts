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
