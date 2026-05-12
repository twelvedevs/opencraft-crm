import type { TemplateSummary } from '../types.js'
import { ApiError } from './SequenceApiClient.js'

export class GatewayApiClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async searchTemplates(channel: 'sms' | 'email', q: string): Promise<TemplateSummary[]> {
    const qs = new URLSearchParams({ channel, q })
    const res = await fetch(`${this.baseUrl}/templates?${qs.toString()}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const message =
        text && text !== '{}' && text !== 'null' ? text : `Request failed with status ${res.status}`
      throw new ApiError(res.status, message)
    }
    return res.json() as Promise<TemplateSummary[]>
  }
}
