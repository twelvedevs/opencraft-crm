import { env } from '../env.js';

/**
 * Sends a report delivery email to one or more recipients via the Email Service.
 *
 * The email body contains a link to the /download endpoint (a 302 redirect that
 * fetches a fresh presigned URL on each click) — NOT to a presigned URL directly.
 */
export async function sendReportEmail(
  runId: string,
  recipientEmails: string[],
  reportName: string,
  period: string,
): Promise<void> {
  const downloadUrl = `${env.CRM_BASE_URL}/reporting/runs/${runId}/download`;
  const subject = `${reportName} — ${period}`;
  const body_html = `<p>Your report is ready: <a href="${downloadUrl}">Download</a></p>`;

  const res = await fetch(`${env.EMAIL_SERVICE_URL}/emails/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.INTERNAL_API_SECRET}`,
    },
    body: JSON.stringify({
      to: recipientEmails,
      subject,
      body_html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Email Service returned ${res.status}: ${text}`);
  }
}
