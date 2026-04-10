import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { LeadServiceClient } from '../clients/lead-service.js';
import type { PipelineEngineClient } from '../clients/pipeline-engine.js';

export interface Lead {
  id: string;
  first_name?: string;
  last_name?: string;
  mobile_phone?: string;
  home_phone?: string;
  email?: string;
  date_of_birth?: string;
  [key: string]: unknown;
}

export interface MatchResult {
  status: 'matched' | 'unmatched' | 'ambiguous';
  matchedLeadId?: string;
  matchTier?: number;
  candidateIds?: string[];
}

export function normalizePhone(raw: string): string | null {
  const parsed = parsePhoneNumberFromString(raw, 'US');
  if (!parsed || !parsed.isValid()) {
    return null;
  }
  return parsed.format('E.164');
}

export function buildPhoneMap(leads: Lead[]): Map<string, Lead[]> {
  const map = new Map<string, Lead[]>();
  for (const lead of leads) {
    if (lead.mobile_phone) {
      const normalized = normalizePhone(lead.mobile_phone);
      if (normalized) {
        const existing = map.get(normalized) ?? [];
        existing.push(lead);
        map.set(normalized, existing);
      }
    }
  }
  return map;
}

export function buildEmailMap(leads: Lead[]): Map<string, Lead[]> {
  const map = new Map<string, Lead[]>();
  for (const lead of leads) {
    if (lead.email) {
      const key = lead.email.toLowerCase();
      const existing = map.get(key) ?? [];
      existing.push(lead);
      map.set(key, existing);
    }
  }
  return map;
}

function singleOrAmbiguous(leads: Lead[], tier: number): MatchResult {
  if (leads.length === 1) {
    return { status: 'matched', matchedLeadId: leads[0].id, matchTier: tier };
  }
  return { status: 'ambiguous', candidateIds: leads.map((l) => l.id) };
}

export class MatchService {
  constructor(
    private readonly _pipelineClient: PipelineEngineClient,
    private readonly leadServiceClient: LeadServiceClient,
  ) {}

  async matchRow(
    row: Record<string, string>,
    phoneMap: Map<string, Lead[]>,
    emailMap: Map<string, Lead[]>,
    leadServiceClient: LeadServiceClient,
    locationId: string,
  ): Promise<MatchResult> {
    // Tier 1: mobile phone
    if (row.mobile_phone) {
      const normalized = normalizePhone(row.mobile_phone);
      if (normalized) {
        const matches = phoneMap.get(normalized);
        if (matches && matches.length > 0) {
          return singleOrAmbiguous(matches, 1);
        }
      }
    }

    // Tier 2: email
    if (row.email) {
      const emailKey = row.email.toLowerCase();
      const matches = emailMap.get(emailKey);
      if (matches && matches.length > 0) {
        return singleOrAmbiguous(matches, 2);
      }
    }

    // Tier 3: name search + home phone filter
    // Tier 4: reuse name search + DOB filter
    let nameResults: Lead[] | null = null;

    if (row.first_name && row.last_name) {
      const q = `${row.first_name} ${row.last_name}`;
      const results = (await leadServiceClient.searchLeads({
        q,
        location_id: locationId,
      })) as Lead[];
      nameResults = results;

      // Tier 3: filter by home phone
      if (row.home_phone && nameResults.length > 0) {
        const normalizedHome = normalizePhone(row.home_phone);
        if (normalizedHome) {
          const homeMatches = nameResults.filter((lead) => {
            if (!lead.home_phone) return false;
            const leadHome = normalizePhone(lead.home_phone);
            return leadHome === normalizedHome;
          });
          if (homeMatches.length > 0) {
            return singleOrAmbiguous(homeMatches, 3);
          }
        }
      }

      // Tier 4: filter by DOB (reuse nameResults — no second API call)
      if (row.date_of_birth && nameResults.length > 0) {
        const dobMatches = nameResults.filter(
          (lead) => lead.date_of_birth === row.date_of_birth,
        );
        if (dobMatches.length > 0) {
          return singleOrAmbiguous(dobMatches, 4);
        }
      }
    }

    // Tier 5: unmatched
    return { status: 'unmatched' };
  }
}
