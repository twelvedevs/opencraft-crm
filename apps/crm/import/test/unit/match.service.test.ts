import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizePhone,
  buildPhoneMap,
  buildEmailMap,
  MatchService,
  type Lead,
} from '../../src/services/match.service.js';
import type { LeadServiceClient } from '../../src/clients/lead-service.js';
import type { PipelineEngineClient } from '../../src/clients/pipeline-engine.js';

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: crypto.randomUUID(),
    first_name: 'John',
    last_name: 'Doe',
    ...overrides,
  };
}

function mockLeadServiceClient(
  searchLeadsImpl?: (...args: unknown[]) => Promise<unknown[]>,
): LeadServiceClient {
  return {
    searchLeads: vi.fn().mockImplementation(searchLeadsImpl ?? (async () => [])),
    createAppointment: vi.fn(),
    deleteAppointment: vi.fn(),
  } as unknown as LeadServiceClient;
}

const mockPipelineClient = {} as PipelineEngineClient;

describe('normalizePhone', () => {
  it('normalizes (212) 555-1234 to E.164', () => {
    expect(normalizePhone('(212) 555-1234')).toBe('+12125551234');
  });

  it('normalizes 212-555-1234 to E.164', () => {
    expect(normalizePhone('212-555-1234')).toBe('+12125551234');
  });

  it('normalizes 2125551234 to E.164', () => {
    expect(normalizePhone('2125551234')).toBe('+12125551234');
  });

  it('returns null for invalid phone', () => {
    expect(normalizePhone('not-a-phone')).toBeNull();
  });
});

describe('buildPhoneMap', () => {
  it('maps normalized mobile phones to leads', () => {
    const lead = makeLead({ mobile_phone: '(212) 555-1234' });
    const map = buildPhoneMap([lead]);
    expect(map.get('+12125551234')).toEqual([lead]);
  });

  it('groups multiple leads with the same phone', () => {
    const lead1 = makeLead({ mobile_phone: '2125551234' });
    const lead2 = makeLead({ mobile_phone: '(212) 555-1234' });
    const map = buildPhoneMap([lead1, lead2]);
    expect(map.get('+12125551234')).toEqual([lead1, lead2]);
  });
});

describe('buildEmailMap', () => {
  it('maps lowercase emails to leads', () => {
    const lead = makeLead({ email: 'John@Example.com' });
    const map = buildEmailMap([lead]);
    expect(map.get('john@example.com')).toEqual([lead]);
  });
});

describe('MatchService.matchRow', () => {
  let service: MatchService;
  let leadClient: LeadServiceClient;

  beforeEach(() => {
    leadClient = mockLeadServiceClient();
    service = new MatchService(mockPipelineClient, leadClient);
  });

  describe('Tier 1 — mobile phone', () => {
    it('returns matched with tier 1 for single phone match', async () => {
      const lead = makeLead({ mobile_phone: '2125551234' });
      const phoneMap = buildPhoneMap([lead]);
      const emailMap = new Map<string, Lead[]>();

      const result = await service.matchRow(
        { mobile_phone: '(212) 555-1234' },
        phoneMap,
        emailMap,
        leadClient,
        'loc-1',
      );

      expect(result).toEqual({
        status: 'matched',
        matchedLeadId: lead.id,
        matchTier: 1,
      });
    });

    it('returns ambiguous when two leads share same phone', async () => {
      const lead1 = makeLead({ mobile_phone: '2125551234' });
      const lead2 = makeLead({ mobile_phone: '2125551234' });
      const phoneMap = buildPhoneMap([lead1, lead2]);
      const emailMap = new Map<string, Lead[]>();

      const result = await service.matchRow(
        { mobile_phone: '2125551234' },
        phoneMap,
        emailMap,
        leadClient,
        'loc-1',
      );

      expect(result).toEqual({
        status: 'ambiguous',
        candidateIds: [lead1.id, lead2.id],
      });
    });

    it('falls to Tier 2 when no phone match', async () => {
      const lead = makeLead({ email: 'test@example.com' });
      const phoneMap = new Map<string, Lead[]>();
      const emailMap = buildEmailMap([lead]);

      const result = await service.matchRow(
        { mobile_phone: '3109999999', email: 'test@example.com' },
        phoneMap,
        emailMap,
        leadClient,
        'loc-1',
      );

      expect(result.status).toBe('matched');
      expect(result.matchTier).toBe(2);
    });
  });

  describe('Tier 2 — email', () => {
    it('returns matched with tier 2 for single email match', async () => {
      const lead = makeLead({ email: 'jane@example.com' });
      const phoneMap = new Map<string, Lead[]>();
      const emailMap = buildEmailMap([lead]);

      const result = await service.matchRow(
        { email: 'Jane@Example.com' },
        phoneMap,
        emailMap,
        leadClient,
        'loc-1',
      );

      expect(result).toEqual({
        status: 'matched',
        matchedLeadId: lead.id,
        matchTier: 2,
      });
    });

    it('falls to Tier 3 when no email match', async () => {
      const phoneMap = new Map<string, Lead[]>();
      const emailMap = new Map<string, Lead[]>();

      const result = await service.matchRow(
        { email: 'nobody@example.com', first_name: 'John', last_name: 'Doe' },
        phoneMap,
        emailMap,
        leadClient,
        'loc-1',
      );

      // No name results from API → falls to Tier 5
      expect(result.status).toBe('unmatched');
    });
  });

  describe('Tier 3 — name search + home phone', () => {
    it('returns matched with tier 3 when name search yields one lead with matching home phone', async () => {
      const lead = makeLead({ home_phone: '+13105551234' });
      const client = mockLeadServiceClient(async () => [lead]);
      service = new MatchService(mockPipelineClient, client);

      const result = await service.matchRow(
        { first_name: 'John', last_name: 'Doe', home_phone: '3105551234' },
        new Map(),
        new Map(),
        client,
        'loc-1',
      );

      expect(result).toEqual({
        status: 'matched',
        matchedLeadId: lead.id,
        matchTier: 3,
      });
    });

    it('returns ambiguous when name search yields two leads with matching home phone', async () => {
      const lead1 = makeLead({ home_phone: '+13105551234' });
      const lead2 = makeLead({ home_phone: '(310) 555-1234' });
      const client = mockLeadServiceClient(async () => [lead1, lead2]);
      service = new MatchService(mockPipelineClient, client);

      const result = await service.matchRow(
        { first_name: 'John', last_name: 'Doe', home_phone: '3105551234' },
        new Map(),
        new Map(),
        client,
        'loc-1',
      );

      expect(result).toEqual({
        status: 'ambiguous',
        candidateIds: [lead1.id, lead2.id],
      });
    });
  });

  describe('Tier 4 — name search + DOB (reuses Tier 3 cache)', () => {
    it('returns matched with tier 4 when DOB matches', async () => {
      const lead = makeLead({ date_of_birth: '1990-01-15' });
      const client = mockLeadServiceClient(async () => [lead]);
      service = new MatchService(mockPipelineClient, client);

      const result = await service.matchRow(
        { first_name: 'John', last_name: 'Doe', date_of_birth: '1990-01-15' },
        new Map(),
        new Map(),
        client,
        'loc-1',
      );

      expect(result).toEqual({
        status: 'matched',
        matchedLeadId: lead.id,
        matchTier: 4,
      });
    });

    it('falls to Tier 5 when no DOB match', async () => {
      const lead = makeLead({ date_of_birth: '1990-01-15' });
      const client = mockLeadServiceClient(async () => [lead]);
      service = new MatchService(mockPipelineClient, client);

      const result = await service.matchRow(
        { first_name: 'John', last_name: 'Doe', date_of_birth: '2000-12-25' },
        new Map(),
        new Map(),
        client,
        'loc-1',
      );

      expect(result).toEqual({ status: 'unmatched' });
    });

    it('makes only ONE Lead Service API call for Tiers 3+4 combined', async () => {
      const lead = makeLead({ date_of_birth: '1990-01-15' });
      const client = mockLeadServiceClient(async () => [lead]);
      service = new MatchService(mockPipelineClient, client);

      await service.matchRow(
        {
          first_name: 'John',
          last_name: 'Doe',
          home_phone: '3100000000', // won't match lead (no home_phone on lead)
          date_of_birth: '1990-01-15',
        },
        new Map(),
        new Map(),
        client,
        'loc-1',
      );

      expect(vi.mocked(client.searchLeads)).toHaveBeenCalledOnce();
    });
  });

  describe('Tier 5 — unmatched', () => {
    it('returns unmatched when all tiers exhausted', async () => {
      const client = mockLeadServiceClient(async () => []);
      service = new MatchService(mockPipelineClient, client);

      const result = await service.matchRow(
        { first_name: 'Nobody', last_name: 'Unknown' },
        new Map(),
        new Map(),
        client,
        'loc-1',
      );

      expect(result).toEqual({ status: 'unmatched' });
    });
  });
});
