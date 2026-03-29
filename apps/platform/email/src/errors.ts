export class DomainNotConfiguredError extends Error {
  constructor(locationId: string) {
    super(`Domain not configured for location: ${locationId}`);
    this.name = 'DomainNotConfiguredError';
  }
}

export class DomainNotVerifiedError extends Error {
  constructor(locationId: string) {
    super(`Domain not verified for location: ${locationId}`);
    this.name = 'DomainNotVerifiedError';
  }
}
