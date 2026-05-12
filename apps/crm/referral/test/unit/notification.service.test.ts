import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/env.js', () => ({
  env: {
    MESSAGING_SERVICE_URL: 'http://messaging:3000',
  },
}));

const fetchMock = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', fetchMock);

import {
  buildExamScheduledMessage,
  buildConversionMessage,
  sendExamNotification,
  sendConversionNotification,
} from '../../src/services/notification.service.js';

import type { Referrer } from '../../src/repositories/referrer.repo.js';
import type { Referral } from '../../src/repositories/referral.repo.js';

function makeReferrer(overrides: Partial<Referrer> = {}): Referrer {
  return {
    id: 'referrer-1',
    referrer_type: 'patient',
    lead_id: 'lead-1',
    location_id: 'loc-1',
    name: 'Jane Doe',
    phone: '+15551234567',
    email: null,
    practice_name: null,
    address: null,
    status: 'active',
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeReferral(overrides: Partial<Referral> = {}): Referral {
  return {
    id: 'referral-1',
    referral_link_id: 'link-1',
    referrer_id: 'referrer-1',
    lead_id: 'lead-2',
    location_id: 'loc-1',
    status: 'pending',
    exam_scheduled_at: null,
    converted_at: null,
    notify_on_exam: true,
    notify_on_conversion: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true });
});

describe('buildExamScheduledMessage', () => {
  it('returns correct string with referrer first name', () => {
    const msg = buildExamScheduledMessage(makeReferrer({ name: 'Jane Doe' }));
    expect(msg).toContain('Jane');
    expect(msg).toContain('scheduled their exam');
  });
});

describe('buildConversionMessage', () => {
  it('returns correct string with referrer first name', () => {
    const msg = buildConversionMessage(makeReferrer({ name: 'John Smith' }));
    expect(msg).toContain('John');
    expect(msg).toContain('started treatment');
  });
});

describe('sendExamNotification', () => {
  it('sends SMS for patient referrer with phone and notify_on_exam=true', async () => {
    await sendExamNotification(makeReferral(), makeReferrer());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://messaging:3000/messages/send');
    const body = JSON.parse(opts.body);
    expect(body.to).toBe('+15551234567');
    expect(body.dedup_key).toBe('referral_exam_notify:referral-1');
  });

  it('skips when notify_on_exam=false', async () => {
    await sendExamNotification(
      makeReferral({ notify_on_exam: false }),
      makeReferrer(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when referrer_type=doctor', async () => {
    await sendExamNotification(
      makeReferral(),
      makeReferrer({ referrer_type: 'doctor' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when phone is null', async () => {
    await sendExamNotification(
      makeReferral(),
      makeReferrer({ phone: null }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendConversionNotification', () => {
  it('sends SMS for patient referrer with phone and notify_on_conversion=true', async () => {
    await sendConversionNotification(makeReferral(), makeReferrer());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.dedup_key).toBe('referral_conversion_notify:referral-1');
  });

  it('skips when notify_on_conversion=false', async () => {
    await sendConversionNotification(
      makeReferral({ notify_on_conversion: false }),
      makeReferrer(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when referrer_type=doctor', async () => {
    await sendConversionNotification(
      makeReferral(),
      makeReferrer({ referrer_type: 'doctor' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when phone is null', async () => {
    await sendConversionNotification(
      makeReferral(),
      makeReferrer({ phone: null }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
