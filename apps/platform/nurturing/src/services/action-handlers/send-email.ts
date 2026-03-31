export interface ResolvedSendEmailParams {
  template_id: string;
  to: string;
  from: string;
  subject?: string;
  dedup_key: string;
  context: Record<string, unknown>;
}

export async function executeSendEmail(
  params: ResolvedSendEmailParams,
  templateServiceUrl: string,
  emailServiceUrl: string,
): Promise<void> {
  const renderRes = await fetch(`${templateServiceUrl}/templates/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template_id: params.template_id, context: params.context }),
  });
  if (!renderRes.ok) {
    throw new Error('template_render_failed');
  }
  const rendered = (await renderRes.json()) as {
    subject: string;
    body_html: string;
    body_text: string;
  };

  const sendRes = await fetch(`${emailServiceUrl}/emails/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: rendered.subject,
      body_html: rendered.body_html,
      body_text: rendered.body_text,
      to: params.to,
      from: params.from,
      dedup_key: params.dedup_key,
    }),
  });
  if (!sendRes.ok) {
    throw new Error('email_send_failed');
  }
}
