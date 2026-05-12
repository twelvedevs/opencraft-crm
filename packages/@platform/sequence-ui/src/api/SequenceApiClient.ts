import type {
  SequenceSummary, SequenceDetail, SequenceDraftPayload,
  Enrollment, EnrollmentDetail, EnrollmentFilters, SequenceStats,
} from '../types.js'

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export class SequenceApiClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const message = text && text !== '{}' && text !== 'null' ? text : `Request failed with status ${res.status}`
      throw new ApiError(res.status, message)
    }
    return res.json() as Promise<T>
  }

  listSequences(): Promise<{ data: SequenceSummary[]; total: number }> {
    return this.request('/sequences')
  }

  getSequence(id: string): Promise<SequenceDetail> {
    return this.request(`/sequences/${id}`)
  }

  createSequence(name: string): Promise<{ sequence_id: string }> {
    return this.request('/sequences', { method: 'POST', body: JSON.stringify({ name }) })
  }

  saveDraft(id: string, payload: SequenceDraftPayload): Promise<void> {
    return this.request(`/sequences/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
  }

  activate(id: string): Promise<void> {
    return this.request(`/sequences/${id}/activate`, { method: 'POST' })
  }

  disable(id: string): Promise<void> {
    return this.request(`/sequences/${id}/disable`, { method: 'POST' })
  }

  listEnrollments(
    id: string,
    params: EnrollmentFilters & { cursor?: string; limit?: number },
  ): Promise<{ data: Enrollment[]; nextCursor?: string }> {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.dateFrom) qs.set('date_from', params.dateFrom)
    if (params.dateTo) qs.set('date_to', params.dateTo)
    if (params.cursor) qs.set('cursor', params.cursor)
    if (params.limit) qs.set('limit', String(params.limit))
    const q = qs.toString()
    return this.request(`/sequences/${id}/enrollments${q ? `?${q}` : ''}`)
  }

  getEnrollmentDetail(sequenceId: string, enrollmentId: string): Promise<EnrollmentDetail> {
    return this.request(`/sequences/${sequenceId}/enrollments/${enrollmentId}`)
  }

  getStats(id: string): Promise<SequenceStats> {
    return this.request(`/sequences/${id}/stats`)
  }
}
