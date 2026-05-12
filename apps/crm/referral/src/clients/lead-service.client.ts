import { env } from '../env.js';

export interface LeadInfo {
  first_name: string;
  last_name: string;
  phone: string | null;
  location_id: string;
}

export async function getLeadById(leadId: string): Promise<LeadInfo> {
  const url = `${env.LEAD_SERVICE_URL}/leads/${leadId}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Internal-Api-Key': env.LEAD_SERVICE_API_KEY,
    },
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    throw new Error(
      `Lead Service returned ${res.status} for lead ${leadId}: ${JSON.stringify(body)}`,
    );
  }

  return (await res.json()) as LeadInfo;
}
