export function buildDisclosureFooter(locationPhone: string): string {
  return `This message was sent automatically. Reply STOP to opt out or call us at ${locationPhone} to speak with our team.`;
}

export function parseAgentResponse(
  responseText: string,
): { text: string; escalate: boolean; reason?: string } | null {
  try {
    const parsed = JSON.parse(responseText);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.text !== 'string' ||
      typeof parsed.escalate !== 'boolean'
    ) {
      return null;
    }
    return {
      text: parsed.text as string,
      escalate: parsed.escalate as boolean,
      reason: typeof parsed.reason === 'string' ? (parsed.reason as string) : undefined,
    };
  } catch {
    return null;
  }
}
