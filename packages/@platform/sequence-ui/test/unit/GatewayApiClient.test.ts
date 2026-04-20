import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewayApiClient } from '../../src/api/GatewayApiClient.js'
import { ApiError } from '../../src/api/SequenceApiClient.js'

const BASE = 'http://gateway.test'
const TOKEN = 'tok-gw'

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(String(body)),
  })
}

describe('GatewayApiClient', () => {
  let client: GatewayApiClient

  beforeEach(() => {
    client = new GatewayApiClient(BASE, TOKEN)
  })

  it('searchTemplates: GET /templates with channel and q params', async () => {
    const templates = [{ template_id: 't1', name: 'T1', channel: 'sms', preview: 'Hi' }]
    global.fetch = mockFetch(200, templates)
    const result = await client.searchTemplates('sms', 'followup')
    expect(result).toEqual(templates)
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/templates')
    expect(url).toContain('channel=sms')
    expect(url).toContain('q=followup')
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('searchTemplates: filters by email channel', async () => {
    global.fetch = mockFetch(200, [])
    await client.searchTemplates('email', '')
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toContain('channel=email')
  })

  it('throws ApiError on non-2xx', async () => {
    global.fetch = mockFetch(500, 'server error')
    await expect(client.searchTemplates('sms', 'x')).rejects.toBeInstanceOf(ApiError)
    await expect(client.searchTemplates('sms', 'x')).rejects.toMatchObject({ status: 500 })
  })
})
