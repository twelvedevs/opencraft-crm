import type { Referrer } from '../repositories/referrer.repo.js';
import type { Referral } from '../repositories/referral.repo.js';
import { env } from '../env.js';

function getFirstName(name: string): string {
  return name.split(' ')[0];
}

export function buildExamScheduledMessage(referrer: Referrer): string {
  const firstName = getFirstName(referrer.name);
  return `Hi ${firstName}! Great news — the person you referred has scheduled their exam. Thank you for your referral!`;
}

export function buildConversionMessage(referrer: Referrer): string {
  const firstName = getFirstName(referrer.name);
  return `Hi ${firstName}! Great news — the person you referred has started treatment. Thank you for your referral!`;
}

export async function sendExamNotification(
  referral: Referral,
  referrer: Referrer,
): Promise<void> {
  if (referrer.referrer_type === 'doctor') return;
  if (!referrer.phone) return;
  if (!referral.notify_on_exam) return;

  const body = buildExamScheduledMessage(referrer);
  const dedupKey = `referral_exam_notify:${referral.id}`;

  await fetch(`${env.MESSAGING_SERVICE_URL}/messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: referrer.phone,
      body,
      dedup_key: dedupKey,
    }),
  });
}

export async function sendConversionNotification(
  referral: Referral,
  referrer: Referrer,
): Promise<void> {
  if (referrer.referrer_type === 'doctor') return;
  if (!referrer.phone) return;
  if (!referral.notify_on_conversion) return;

  const body = buildConversionMessage(referrer);
  const dedupKey = `referral_conversion_notify:${referral.id}`;

  await fetch(`${env.MESSAGING_SERVICE_URL}/messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: referrer.phone,
      body,
      dedup_key: dedupKey,
    }),
  });
}
