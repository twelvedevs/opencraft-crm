import { env } from '../env.js';

export class LeadServiceError extends Error {
  public readonly httpStatus: number;

  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = 'LeadServiceError';
    this.httpStatus = httpStatus;
  }
}

export class LeadServiceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = env.LEAD_SERVICE_URL;
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
      throw new LeadServiceError(res.status, `LeadServiceError: ${res.status}`);
    }

    return (await res.json()) as T;
  }

  async searchLeads(params: {
    phones?: string[];
    emails?: string[];
    q?: string;
    location_id: string;
  }): Promise<unknown[]> {
    const qs = new URLSearchParams();
    qs.set('location_id', params.location_id);

    if (params.phones) {
      for (const phone of params.phones) {
        qs.append('phones[]', phone);
      }
    }
    if (params.emails) {
      for (const email of params.emails) {
        qs.append('emails[]', email);
      }
    }
    if (params.q) {
      qs.set('q', params.q);
    }

    return this.request<unknown[]>('GET', `/leads?${qs.toString()}`);
  }

  async createAppointment(
    leadId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request('POST', `/leads/${leadId}/appointments`, body);
  }

  async deleteAppointment(
    leadId: string,
    appointmentId: string,
  ): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };

    const res = await fetch(`${this.baseUrl}/leads/${leadId}/appointments/${appointmentId}`, {
      method: 'DELETE',
      headers,
    });

    if (!res.ok) {
      throw new LeadServiceError(res.status, `LeadServiceError: ${res.status}`);
    }
  }
}
