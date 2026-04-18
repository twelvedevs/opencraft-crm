import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  readConfig:    vi.fn(() => ({ gateway_url: 'http://localhost:3000' })),
  resolveToken:  vi.fn(() => 'test-token'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { uploadFile, ApiError, NetworkError } = await import('../src/client.js');

describe('uploadFile', () => {
  beforeEach(() => mockFetch.mockReset());

  it('sends multipart POST to /v1/<path> with Authorization header', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'abc' }) });
    const fd = new FormData();
    fd.append('import_type', 'active_patients');
    await uploadFile('/imports/upload', fd);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/imports/upload',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        body: fd,
      })
    );
  });

  it('does NOT set Content-Type header (lets fetch handle boundary)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const fd = new FormData();
    await uploadFile('/imports/upload', fd);
    const headers = (mockFetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string,string>;
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('throws NetworkError when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(uploadFile('/imports/upload', new FormData())).rejects.toThrow(NetworkError);
  });

  it('throws ApiError on 401', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401, json: async () => ({ error: 'unauthorized' }),
    });
    const err = await uploadFile('/imports/upload', new FormData()).catch(e => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  it('throws ApiError on 4xx with error field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 422, statusText: 'Unprocessable Entity',
      json: async () => ({ error: 'invalid_csv' }),
    });
    const err = await uploadFile('/imports/upload', new FormData()).catch(e => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.apiError).toBe('invalid_csv');
  });
});
