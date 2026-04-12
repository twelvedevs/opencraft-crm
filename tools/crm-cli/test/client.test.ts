import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveToken = vi.fn(() => 'test-token');
vi.mock('../src/config.js', () => ({
  readConfig: vi.fn(() => ({
    gateway_url: 'http://localhost:3000',
    gotrue_url:  'http://localhost:9999',
    identity_url: 'http://localhost:3100',
  })),
  resolveToken: mockResolveToken,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { request, ApiError, NetworkError } = await import('../src/client.js');

describe('request', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockResolveToken.mockReset().mockReturnValue('test-token');
  });

  it('sends GET to gateway with Authorization header and /v1 prefix', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ leads: [] }),
    });
    await request('/leads');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/leads',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      })
    );
  });

  it('sends POST with JSON body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'abc' }) });
    await request('/leads', { method: 'POST', body: { first_name: 'Jane' } });
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[1].body).toBe(JSON.stringify({ first_name: 'Jane' }));
  });

  it('throws NetworkError when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(request('/leads')).rejects.toThrow(NetworkError);
  });

  it('throws ApiError with login hint on 401', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid_token' }),
    });
    const err = await request('/leads').catch(e => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.apiError).toMatch(/Token may be expired/);
  });

  it('throws ApiError with status code on 4xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: 'not_found' }),
    });
    const err = await request('/leads/bad').catch(e => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.apiError).toBe('not_found');
  });

  it('throws ApiError with service hint on 5xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const err = await request('/leads').catch(e => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.apiError).toMatch(/Server error/);
  });

  it('passes override token to resolveToken', async () => {
    mockResolveToken.mockReturnValueOnce('my-override');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await request('/leads', { token: 'my-override' });
    expect(mockResolveToken).toHaveBeenCalledWith('my-override');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer my-override' }),
      })
    );
  });

  it('uses override gateway URL when provided', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await request('/leads', { gatewayUrl: 'http://other:3000' });
    expect(mockFetch).toHaveBeenCalledWith('http://other:3000/v1/leads', expect.any(Object));
  });
});
