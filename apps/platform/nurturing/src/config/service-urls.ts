export interface ServiceUrls {
  templateServiceUrl: string;
  messagingServiceUrl: string;
  emailServiceUrl: string;
  aiServiceUrl: string;
}

export function loadServiceUrls(): ServiceUrls {
  const required = {
    templateServiceUrl: process.env['TEMPLATE_SERVICE_URL'],
    messagingServiceUrl: process.env['MESSAGING_SERVICE_URL'],
    emailServiceUrl: process.env['EMAIL_SERVICE_URL'],
    aiServiceUrl: process.env['AI_SERVICE_URL'],
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return required as ServiceUrls;
}
