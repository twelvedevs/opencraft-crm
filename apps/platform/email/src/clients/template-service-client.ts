export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

export class TemplateServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateServiceUnavailableError';
  }
}

export class TemplateServiceClient {
  constructor(private readonly baseUrl: string) {}

  async render(
    templateId: string,
    context: Record<string, unknown>,
  ): Promise<{ html: string; text?: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/templates/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: templateId, context }),
      });
    } catch (err) {
      throw new TemplateServiceUnavailableError(
        `Template service request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status >= 400 && response.status < 500) {
      throw new TemplateRenderError(
        `Template render failed with status ${response.status}`,
      );
    }

    if (response.status >= 500) {
      throw new TemplateServiceUnavailableError(
        `Template service returned status ${response.status}`,
      );
    }

    return response.json() as Promise<{ html: string; text?: string }>;
  }
}
