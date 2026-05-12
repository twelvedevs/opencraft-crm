import { env } from '../env.js';

export class PipelineEngineError extends Error {
  public readonly httpStatus: number;

  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = 'PipelineEngineError';
    this.httpStatus = httpStatus;
  }
}

export class PipelineEngineClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = env.PIPELINE_ENGINE_URL;
    this.apiKey = env.IMPORT_SERVICE_API_KEY;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      throw new PipelineEngineError(res.status, `PipelineEngineError: ${res.status}`);
    }

    return (await res.json()) as T;
  }

  async getMemberships(
    leadId: string,
    pipeline: string,
    status: string,
  ): Promise<unknown[]> {
    const params = new URLSearchParams({
      lead_id: leadId,
      pipeline,
      status,
    });
    return this.request<unknown[]>('GET', `/pipeline/memberships?${params.toString()}`);
  }

  async createTransition(
    membershipId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request('POST', `/pipeline/memberships/${membershipId}/transition`, body);
  }

  async convertMembership(
    membershipId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request('POST', `/pipeline/memberships/${membershipId}/convert`, body);
  }

  async closeMembership(
    membershipId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request('POST', `/pipeline/memberships/${membershipId}/close`, body);
  }

  async enrollMembership(body: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/pipeline/memberships', body);
  }
}
