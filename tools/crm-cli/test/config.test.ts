import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs');
const mockFs = vi.mocked(fs);

// Import after mock is set up
const { readConfig, writeConfig, updateConfig, resolveToken } = await import('../src/config.js');

describe('readConfig', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns defaults when file does not exist', () => {
    mockFs.readFileSync.mockImplementation(() => { throw Object.assign(new Error(), { code: 'ENOENT' }); });
    const cfg = readConfig();
    expect(cfg.gateway_url).toBe('http://localhost:3000');
    expect(cfg.gotrue_url).toBe('http://localhost:9999');
    expect(cfg.identity_url).toBe('http://localhost:3100');
    expect(cfg.access_token).toBeUndefined();
  });

  it('merges saved values over defaults', () => {
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ gateway_url: 'http://staging:3000', access_token: 'tok123' })
    );
    const cfg = readConfig();
    expect(cfg.gateway_url).toBe('http://staging:3000');
    expect(cfg.gotrue_url).toBe('http://localhost:9999');
    expect(cfg.access_token).toBe('tok123');
  });
});

describe('writeConfig', () => {
  it('creates ~/.crm dir and writes JSON', () => {
    mockFs.mkdirSync.mockImplementation(() => undefined);
    mockFs.writeFileSync.mockImplementation(() => undefined);
    writeConfig({
      gateway_url: 'http://localhost:3000',
      gotrue_url: 'http://localhost:9999',
      identity_url: 'http://localhost:3100',
      access_token: 'tok',
    });
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.crm'), { recursive: true }
    );
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
      expect.stringContaining('"access_token": "tok"'),
      { mode: 0o600, encoding: 'utf-8' }
    );
  });
});

describe('updateConfig', () => {
  beforeEach(() => vi.resetAllMocks());

  it('merges updates into existing config', () => {
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ gateway_url: 'http://localhost:3000', access_token: 'old' })
    );
    mockFs.mkdirSync.mockImplementation(() => undefined);
    mockFs.writeFileSync.mockImplementation(() => undefined);
    updateConfig({ gateway_url: 'http://staging:3000' });
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
      expect.stringContaining('"gateway_url": "http://staging:3000"'),
      { mode: 0o600, encoding: 'utf-8' }
    );
    // Verify existing fields are preserved
    const written = (mockFs.writeFileSync.mock.calls[0] as unknown[])[1] as string;
    expect(written).toContain('"access_token": "old"');
  });
});

describe('resolveToken', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env['CRM_TOKEN'];
  });

  it('returns explicit override first', () => {
    expect(resolveToken('override')).toBe('override');
  });

  it('returns CRM_TOKEN env var over config', () => {
    process.env['CRM_TOKEN'] = 'env-tok';
    expect(resolveToken()).toBe('env-tok');
  });

  it('returns config token as fallback', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ access_token: 'cfg-tok' }));
    expect(resolveToken()).toBe('cfg-tok');
  });

  it('returns undefined when nothing is set', () => {
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(resolveToken()).toBeUndefined();
  });
});
