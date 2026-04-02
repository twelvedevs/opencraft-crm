import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { GoogleAdsConnector } from '../../src/connectors/google-ads.js';

const config = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  developerToken: 'test-dev-token',
  redirectUri: 'http://localhost:3000/callback',
  webhookVerifyToken: 'test-webhook-secret',
  encryptionKey: Buffer.alloc(32, 'a'),
};

describe('GoogleAdsConnector', () => {
  const connector = new GoogleAdsConnector(config);

  describe('verifyWebhook', () => {
    it('returns true for valid HMAC signature', () => {
      const body = Buffer.from('{"leads":[]}');
      const sig = createHmac('sha256', config.webhookVerifyToken)
        .update(body)
        .digest('hex');

      expect(connector.verifyWebhook({ 'x-goog-signature': sig }, body)).toBe(true);
    });

    it('returns false for wrong secret / tampered body', () => {
      const body = Buffer.from('{"leads":[]}');
      const sig = createHmac('sha256', 'wrong-secret')
        .update(body)
        .digest('hex');

      expect(connector.verifyWebhook({ 'x-goog-signature': sig }, body)).toBe(false);
    });

    it('returns false when signature header is missing', () => {
      const body = Buffer.from('{}');
      expect(connector.verifyWebhook({}, body)).toBe(false);
    });
  });

  describe('parseLeadWebhook', () => {
    it('returns correct LeadEvent[] for well-formed payload', () => {
      const payload = {
        leads: [
          {
            lead_id: 'lead-001',
            campaign_id: 'camp-123',
            ad_id: 'ad-456',
            form_id: 'form-789',
            user_column_data: [
              { column_name: 'Full Name', string_value: 'John Doe' },
              { column_name: 'Email', string_value: 'john@example.com' },
            ],
          },
          {
            lead_id: 'lead-002',
            campaign_id: 'camp-123',
            column_data: [
              { column_name: 'Phone', string_value: '555-1234' },
            ],
          },
        ],
      };

      const events = connector.parseLeadWebhook(payload);
      expect(events).toHaveLength(2);

      expect(events[0]).toEqual({
        external_lead_id: 'lead-001',
        campaign_id: 'camp-123',
        ad_id: 'ad-456',
        form_id: 'form-789',
        fields: { 'Full Name': 'John Doe', Email: 'john@example.com' },
      });

      expect(events[1]).toEqual({
        external_lead_id: 'lead-002',
        campaign_id: 'camp-123',
        ad_id: undefined,
        form_id: undefined,
        fields: { Phone: '555-1234' },
      });
    });

    it('throws for unrecognisable structure (not an object)', () => {
      expect(() => connector.parseLeadWebhook(null)).toThrow('payload is not an object');
      expect(() => connector.parseLeadWebhook('string')).toThrow('payload is not an object');
    });

    it('throws for missing leads array', () => {
      expect(() => connector.parseLeadWebhook({ data: 'something' })).toThrow('missing leads array');
    });
  });

  describe('verifyChallenge', () => {
    it('returns challenge token when verify_token matches', () => {
      const query = {
        'hub.verify_token': config.webhookVerifyToken,
        'hub.challenge': 'challenge-abc-123',
      };
      expect(connector.verifyChallenge(query)).toBe('challenge-abc-123');
    });

    it('returns null when verify_token does not match', () => {
      const query = {
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'challenge-abc-123',
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
