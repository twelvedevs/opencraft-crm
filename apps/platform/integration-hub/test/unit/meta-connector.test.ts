import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { MetaConnector } from '../../src/connectors/meta.js';

const config = {
  appId: 'test-app-id',
  appSecret: 'test-app-secret',
  redirectUri: 'http://localhost:3000/callback',
  webhookVerifyToken: 'test-meta-verify-token',
  encryptionKey: Buffer.alloc(32, 'b'),
};

describe('MetaConnector', () => {
  const connector = new MetaConnector(config);

  describe('verifyWebhook', () => {
    it('returns true for valid X-Hub-Signature-256', () => {
      const body = Buffer.from('{"entry":[]}');
      const sig = createHmac('sha256', config.appSecret)
        .update(body)
        .digest('hex');

      expect(
        connector.verifyWebhook({ 'x-hub-signature-256': `sha256=${sig}` }, body),
      ).toBe(true);
    });

    it('returns false for tampered body', () => {
      const body = Buffer.from('{"entry":[]}');
      const sig = createHmac('sha256', config.appSecret)
        .update(body)
        .digest('hex');

      const tamperedBody = Buffer.from('{"entry":["tampered"]}');
      expect(
        connector.verifyWebhook({ 'x-hub-signature-256': `sha256=${sig}` }, tamperedBody),
      ).toBe(false);
    });

    it('returns false when signature header is missing', () => {
      expect(connector.verifyWebhook({}, Buffer.from('{}'))).toBe(false);
    });

    it('returns false for malformed signature format', () => {
      expect(
        connector.verifyWebhook({ 'x-hub-signature-256': 'invalid' }, Buffer.from('{}')),
      ).toBe(false);
    });
  });

  describe('parseLeadWebhook', () => {
    it('returns LeadEvent[] for valid Meta leadgen webhook with batched entries', () => {
      const payload = {
        entry: [
          {
            changes: [
              {
                field: 'leadgen',
                value: {
                  leadgen_id: 'lg-100',
                  campaign_id: 'camp-200',
                  adgroup_id: 'adset-300',
                  ad_id: 'ad-400',
                  form_id: 'form-500',
                  page_id: 'page-600',
                },
              },
              {
                field: 'leadgen',
                value: {
                  leadgen_id: 'lg-101',
                  campaign_id: 'camp-201',
                },
              },
            ],
          },
          {
            changes: [
              {
                field: 'leadgen',
                value: {
                  leadgen_id: 'lg-102',
                  campaign_id: 'camp-202',
                  adgroup_id: 'adset-302',
                },
              },
            ],
          },
        ],
      };

      const events = connector.parseLeadWebhook(payload);
      expect(events).toHaveLength(3);

      expect(events[0]).toEqual({
        external_lead_id: 'lg-100',
        campaign_id: 'camp-200',
        ad_set_id: 'adset-300',
        ad_id: 'ad-400',
        form_id: 'form-500',
        fields: {},
      });

      expect(events[1]).toEqual({
        external_lead_id: 'lg-101',
        campaign_id: 'camp-201',
        ad_set_id: undefined,
        ad_id: undefined,
        form_id: undefined,
        fields: {},
      });

      expect(events[2]).toEqual({
        external_lead_id: 'lg-102',
        campaign_id: 'camp-202',
        ad_set_id: 'adset-302',
        ad_id: undefined,
        form_id: undefined,
        fields: {},
      });
    });

    it('returns [] for empty changes', () => {
      const payload = {
        entry: [{ changes: [] }],
      };
      expect(connector.parseLeadWebhook(payload)).toEqual([]);
    });

    it('filters out non-leadgen changes', () => {
      const payload = {
        entry: [
          {
            changes: [
              { field: 'other_field', value: { leadgen_id: 'ignored' } },
              {
                field: 'leadgen',
                value: { leadgen_id: 'lg-999', campaign_id: 'camp-999' },
              },
            ],
          },
        ],
      };

      const events = connector.parseLeadWebhook(payload);
      expect(events).toHaveLength(1);
      expect(events[0]!.external_lead_id).toBe('lg-999');
    });

    it('throws for malformed structure (not an object)', () => {
      expect(() => connector.parseLeadWebhook(null)).toThrow('payload is not an object');
      expect(() => connector.parseLeadWebhook(42)).toThrow('payload is not an object');
    });

    it('throws for missing entry array', () => {
      expect(() => connector.parseLeadWebhook({ data: 'bad' })).toThrow('missing entry array');
    });
  });

  describe('verifyChallenge', () => {
    it('returns challenge when verify_token matches', () => {
      const query = {
        'hub.verify_token': config.webhookVerifyToken,
        'hub.challenge': 'meta-challenge-xyz',
      };
      expect(connector.verifyChallenge(query)).toBe('meta-challenge-xyz');
    });

    it('returns null when verify_token does not match', () => {
      const query = {
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'meta-challenge-xyz',
      };
      expect(connector.verifyChallenge(query)).toBeNull();
    });

    it('returns null when verify_token matches but no challenge present', () => {
      const query = {
        'hub.verify_token': config.webhookVerifyToken,
      };
      expect(connector.verifyChallenge(query)).toBeNull();
    });
  });
});
