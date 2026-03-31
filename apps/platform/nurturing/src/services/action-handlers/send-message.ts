export interface ResolvedSendMessageParams {
  template_id: string;
  to: string;
  from: string;
  dedup_key: string;
  context: Record<string, unknown>;
}

export async function executeSendMessage(
  params: ResolvedSendMessageParams,
  templateServiceUrl: string,
  messagingServiceUrl: string,
): Promise<void> {
  const renderRes = await fetch(`${templateServiceUrl}/templates/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template_id: params.template_id, context: params.context }),
  });
  if (!renderRes.ok) {
    throw new Error('template_render_failed');
  }
  const rendered = (await renderRes.json()) as { body: string };

  const sendRes = await fetch(`${messagingServiceUrl}/messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: rendered.body,
      to: params.to,
      from: params.from,
      dedup_key: params.dedup_key,
    }),
  });
  if (!sendRes.ok) {
    throw new Error('messaging_send_failed');
  }
}
