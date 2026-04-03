import { createPublicKey } from 'node:crypto';
import axios from 'axios';
import { createVerifier } from 'fast-jwt';
import type { AuthProvider } from './auth-provider.interface.js';

interface M2MTokenCache {
  token: string;
  expiresAt: number;
}

export class Auth0Provider implements AuthProvider {
  private auth0Domain: string;
  private clientId: string;
  private clientSecret: string;
  private m2mTokenCache: M2MTokenCache | null = null;
  // Cache PEM public keys by kid to avoid fetching JWKS on every verifyToken call.
  // Re-fetches when a token presents an unknown kid (same strategy as auth-middleware).
  private jwksCache = new Map<string, string>(); // kid → PEM

  constructor(auth0Domain: string, clientId: string, clientSecret: string) {
    this.auth0Domain = auth0Domain;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  private async getManagementToken(): Promise<string> {
    if (this.m2mTokenCache && this.m2mTokenCache.expiresAt > Date.now() + 60_000) {
      return this.m2mTokenCache.token;
    }

    const response = await axios.post(`https://${this.auth0Domain}/oauth/token`, {
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      audience: `https://${this.auth0Domain}/api/v2/`,
    });

    const { access_token, expires_in } = response.data;
    this.m2mTokenCache = {
      token: access_token,
      expiresAt: Date.now() + expires_in * 1000,
    };

    return access_token;
  }

  private async fetchJwks(): Promise<void> {
    const jwksResponse = await axios.get(`https://${this.auth0Domain}/.well-known/jwks.json`);
    for (const jwk of jwksResponse.data.keys as { kid: string; kty: string; n: string; e: string }[]) {
      const pem = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }) as string;
      this.jwksCache.set(jwk.kid, pem);
    }
  }

  async verifyToken(token: string): Promise<{ providerUserId: string; email: string }> {
    // Decode header to find kid
    const headerB64 = token.split('.')[0];
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    const kid = header.kid;

    // Populate cache on first call or re-fetch when kid is unknown
    if (!this.jwksCache.has(kid)) {
      await this.fetchJwks();
    }

    const pem = this.jwksCache.get(kid);
    if (!pem) {
      throw new Error('Unable to find matching key for token verification');
    }

    const verifier = createVerifier({ algorithms: ['RS256'], key: pem });
    const payload = verifier(token);

    return {
      providerUserId: payload.sub,
      email: payload.email ?? payload[`https://${this.auth0Domain}/email`],
    };
  }

  async createUser(email: string, password: string): Promise<{ providerUserId: string }> {
    const managementToken = await this.getManagementToken();

    const response = await axios.post(
      `https://${this.auth0Domain}/api/v2/users`,
      {
        email,
        password,
        connection: 'Username-Password-Authentication',
      },
      {
        headers: { Authorization: `Bearer ${managementToken}` },
      },
    );

    return { providerUserId: response.data.user_id };
  }

  async setPassword(providerUserId: string, password: string): Promise<void> {
    const managementToken = await this.getManagementToken();

    await axios.patch(
      `https://${this.auth0Domain}/api/v2/users/${encodeURIComponent(providerUserId)}`,
      { password },
      {
        headers: { Authorization: `Bearer ${managementToken}` },
      },
    );
  }

  async deactivateUser(providerUserId: string): Promise<void> {
    const managementToken = await this.getManagementToken();

    await axios.patch(
      `https://${this.auth0Domain}/api/v2/users/${encodeURIComponent(providerUserId)}`,
      { blocked: true },
      {
        headers: { Authorization: `Bearer ${managementToken}` },
      },
    );
  }

  async signInWithPassword(email: string, password: string): Promise<void> {
    await axios.post(`https://${this.auth0Domain}/oauth/token`, {
      grant_type: 'password',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      username: email,
      password,
      audience: `https://${this.auth0Domain}/api/v2/`,
    });
  }
}
