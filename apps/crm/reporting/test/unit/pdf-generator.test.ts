import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Puppeteer mock — defined with vi.hoisted so they are available inside vi.mock
// ---------------------------------------------------------------------------

const mockSetDefaultTimeout = vi.hoisted(() => vi.fn());
const mockSetContent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPdf = vi.hoisted(() => vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])));
const mockClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockNewPage = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    setDefaultTimeout: mockSetDefaultTimeout,
    setContent: mockSetContent,
    pdf: mockPdf,
  }),
);
const mockLaunch = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    newPage: mockNewPage,
    close: mockClose,
  }),
);

vi.mock('puppeteer', () => ({
  default: {
    launch: mockLaunch,
  },
}));

import { generatePdf } from '../../src/services/pdf-generator.js';
import puppeteer from 'puppeteer';

// ---------------------------------------------------------------------------
// Test setup — reset mocks and restore defaults before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  mockPdf.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
  mockSetContent.mockResolvedValue(undefined);
  mockNewPage.mockResolvedValue({
    setDefaultTimeout: mockSetDefaultTimeout,
    setContent: mockSetContent,
    pdf: mockPdf,
  });
  mockClose.mockResolvedValue(undefined);
  mockLaunch.mockResolvedValue({
    newPage: mockNewPage,
    close: mockClose,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pdf-generator', () => {
  describe('puppeteer launch args', () => {
    it('launches Puppeteer with --no-sandbox, --disable-setuid-sandbox, --disable-dev-shm-usage', async () => {
      await generatePdf('weekly_summary', {});

      expect(puppeteer.launch).toHaveBeenCalledWith({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    });
  });

  describe('page timeout', () => {
    it('calls page.setDefaultTimeout(30000) immediately after page creation', async () => {
      await generatePdf('weekly_summary', {});

      expect(mockSetDefaultTimeout).toHaveBeenCalledWith(30_000);
    });
  });

  describe('finally block', () => {
    it('calls browser.close() even when page.pdf() throws', async () => {
      mockPdf.mockRejectedValueOnce(new Error('PDF render failed'));

      await expect(generatePdf('weekly_summary', {})).rejects.toThrow('PDF render failed');

      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('calls browser.close() on successful generation', async () => {
      await generatePdf('weekly_summary', {});

      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('return value', () => {
    it('returns a Buffer', async () => {
      const result = await generatePdf('monthly_executive', {});

      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it('returns a non-empty Buffer', async () => {
      const result = await generatePdf('channel_deep_dive', {});

      expect(result.length).toBeGreaterThan(0);
    });
  });
});
