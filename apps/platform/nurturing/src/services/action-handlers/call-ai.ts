export interface ResolvedCallAiParams {
  system_prompt: string;
  user_prompt: string;
  model: string;
  auto_send?: boolean;
}

export interface CallAiResult {
  output: string;
  auto_send: boolean;
}

export async function executeCallAi(
  params: ResolvedCallAiParams,
  aiServiceUrl: string,
): Promise<CallAiResult> {
  const res = await fetch(`${aiServiceUrl}/ai/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_prompt: params.system_prompt,
      user_prompt: params.user_prompt,
      model: params.model,
    }),
  });
  if (!res.ok) {
    throw new Error('ai_complete_failed');
  }
  const responseBody = (await res.json()) as { text: string };
  return { output: responseBody.text, auto_send: params.auto_send ?? false };
}
