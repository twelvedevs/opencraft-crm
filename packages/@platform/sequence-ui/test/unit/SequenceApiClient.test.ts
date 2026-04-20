import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SequenceApiClient, ApiError } from '../../src/api/SequenceApiClient.js'

const BASE = 'http://nurturing.test'
const TOKEN = 'tok-abc'

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

describe('SequenceApiClient', () => {
  let client: SequenceApiClient

  beforeEach(() => {
    client = new SequenceApiClient(BASE, TOKEN)
  })

  it('listSequences: GET /sequences with auth header', async () => {
    const payload = { data: [], total: 0 }
    global.fetch = mockFetch(200, payload)
    const result = await client.listSequences()
    expect(result).toEqual(payload)
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/sequences`)
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('getSequence: GET /sequences/:id', async () => {
    const payload = { sequence_id: 'seq-1', name: 'Test' }
    global.fetch = mockFetch(200, payload)
    const result = await client.getSequence('seq-1')
    expect(result).toEqual(payload)
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toBe(`${BASE}/sequences/seq-1`)
  })

  it('createSequence: POST /sequences with name', async () => {
    global.fetch = mockFetch(201, { sequence_id: 'seq-new' })
    const result = await client.createSequence('My Sequence')
    expect(result).toEqual({ sequence_id: 'seq-new' })
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'My Sequence' })
  })

  it('saveDraft: PUT /sequences/:id', async () => {
    global.fetch = mockFetch(200, {})
    const payload = { name: 'X', active_hours: null, cancel_on_opt_out: true, steps: [], ab_test: null }
    await client.saveDraft('seq-1', payload)
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/sequences/seq-1`)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual(payload)
  })

  it('activate: POST /sequences/:id/activate', async () => {
    global.fetch = mockFetch(200, {})
    await client.activate('seq-1')
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/sequences/seq-1/activate`)
    expect(init.method).toBe('POST')
  })

  it('disable: POST /sequences/:id/disable', async () => {
    global.fetch = mockFetch(200, {})
    await client.disable('seq-1')
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toBe(`${BASE}/sequences/seq-1/disable`)
  })

  it('listEnrollments: appends query params', async () => {
    global.fetch = mockFetch(200, { data: [], nextCursor: undefined })
    await client.listEnrollments('seq-1', { status: 'active', limit: 50 })
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toContain('status=active')
    expect(url).toContain('limit=50')
    expect(url).toContain('/sequences/seq-1/enrollments')
  })

  it('getStats: GET /sequences/:id/stats', async () => {
    const stats = { sequence_id: 'seq-1', total_enrollments: 10, ab: null }
    global.fetch = mockFetch(200, stats)
    const result = await client.getStats('seq-1')
    expect(result).toEqual(stats)
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toBe(`${BASE}/sequences/seq-1/stats`)
  })

  it('throws ApiError on non-2xx response', async () => {
    global.fetch = mockFetch(404, { message: 'not found' })
    await expect(client.getSequence('missing')).rejects.toBeInstanceOf(ApiError)
    await expect(client.getSequence('missing')).rejects.toMatchObject({ status: 404 })
  })
})
