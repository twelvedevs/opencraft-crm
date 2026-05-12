import type { SegmentSummary, SegmentStatus } from './types.js';

export class AudienceApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async listSegments(status?: string): Promise<{ items: SegmentSummary[]; total: number }> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    const qs = params.toString();
    const url = `${this.baseUrl}/audiences/segments${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`listSegments failed: ${res.status}`);
    return res.json() as Promise<{ items: SegmentSummary[]; total: number }>;
  }

  async createSegment(name: string, filter: unknown): Promise<{ segment_id: string; version: number }> {
    const res = await fetch(`${this.baseUrl}/audiences/segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, filter }),
    });
    if (!res.ok) throw new Error(`createSegment failed: ${res.status}`);
    return res.json() as Promise<{ segment_id: string; version: number }>;
  }

  async activateSegment(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/audiences/segments/${id}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`activateSegment failed: ${res.status}`);
  }

  async disableSegment(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/audiences/segments/${id}/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`disableSegment failed: ${res.status}`);
  }

  async getSegment(id: string): Promise<{
    segment_id: string;
    name: string;
    filter: unknown | null;
    status: SegmentStatus;
    active_version: number | null;
    current_version: number;
  }> {
    const res = await fetch(`${this.baseUrl}/audiences/segments/${id}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`getSegment failed: ${res.status}`);
    return res.json() as Promise<{
      segment_id: string;
      name: string;
      filter: unknown | null;
      status: SegmentStatus;
      active_version: number | null;
      current_version: number;
    }>;
  }

  async updateSegment(id: string, filter: unknown): Promise<{ segment_id: string; version: number; status: string }> {
    const res = await fetch(`${this.baseUrl}/audiences/segments/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter }),
    });
    if (!res.ok) throw new Error(`updateSegment failed: ${res.status}`);
    return res.json() as Promise<{ segment_id: string; version: number; status: string }>;
  }

  async evaluateInline(filter: unknown, entities: Record<string, unknown>[]): Promise<{ matched_count: number; entity_ids: string[] }> {
    const res = await fetch(`${this.baseUrl}/audiences/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter, entities, done: true, snapshot: false }),
    });
    if (!res.ok) throw new Error(`evaluateInline failed: ${res.status}`);
    return res.json() as Promise<{ matched_count: number; entity_ids: string[] }>;
  }
}
