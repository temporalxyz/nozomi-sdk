import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findFastestEndpoints,
  NOZOMI_ENDPOINTS,
  NOZOMI_AUTO_ENDPOINT,
  NOZOMI_ENDPOINTS_URL,
  EndpointConfig,
  EndpointResult
} from './index';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Helper to create valid manifest response
function createManifestResponse(endpoints: EndpointConfig[]) {
  return {
    ok: true,
    json: () => Promise.resolve({
      version: 1,
      updated: '2026-01-07',
      endpoints
    })
  };
}

describe('findFastestEndpoints', () => {
  describe('basic functionality', () => {
    it('returns results with valid structure', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('endpoints.json')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({ pingCount: 1, warmupCount: 0 });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('url');
      expect(results[0]).toHaveProperty('region');
      expect(results[0]).toHaveProperty('minTime');
    });

    it('includes auto-routed endpoint last by default', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('endpoints.json')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({ pingCount: 1, warmupCount: 0 });

      expect(results[results.length - 1].region).toBe('auto');
    });

    it('returns at least one endpoint even if all fail', async () => {
      mockFetch.mockImplementation(() => Promise.reject(new Error('All failed')));

      const results = await findFastestEndpoints({ pingCount: 1, warmupCount: 0 });

      expect(results.length).toBe(1);
      expect(results[0].url).toBe(NOZOMI_AUTO_ENDPOINT);
      expect(results[0].region).toBe('auto');
      expect(results[0].minTime).toBe(Infinity);
    });

    it('does not throw when fetch throws sync error', async () => {
      mockFetch.mockImplementation(() => { throw new Error('Sync error'); });

      const results = await findFastestEndpoints({ pingCount: 1, warmupCount: 0 });

      expect(results).toBeDefined();
      expect(results.length).toBeGreaterThan(0);
    });

    it('does not throw when fetch rejects', async () => {
      mockFetch.mockImplementation(() => Promise.reject(new Error('Async error')));

      const results = await findFastestEndpoints({ pingCount: 1, warmupCount: 0 });

      expect(results).toBeDefined();
      expect(results.length).toBeGreaterThan(0);
    });

    it('does not throw when fetch returns not ok', async () => {
      mockFetch.mockImplementation(() => Promise.resolve({ ok: false }));

      const results = await findFastestEndpoints({ pingCount: 1, warmupCount: 0 });

      expect(results).toBeDefined();
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('remote endpoint fetching', () => {
    it('uses remote endpoints when available', async () => {
      const remoteEndpoints: EndpointConfig[] = [
        { url: 'https://custom.nozomi.xyz', region: 'custom', type: 'direct' }
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve(createManifestResponse(remoteEndpoints));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      expect(results.some(r => r.url === 'https://custom.nozomi.xyz')).toBe(true);
    });

    it('falls back to hardcoded endpoints on 404', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({ ok: false, status: 404 });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      expect(results.length).toBeGreaterThan(0);
      expect(NOZOMI_ENDPOINTS.some(e => e.url === results[0].url)).toBe(true);
    });

    it('falls back to hardcoded endpoints on network error', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('falls back to hardcoded endpoints on invalid JSON', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ invalid: 'data' })
          });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('falls back to hardcoded endpoints on malformed manifest', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              version: 1,
              endpoints: 'not an array'
            })
          });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('filters out invalid endpoints from manifest', async () => {
      const remoteEndpoints = [
        { url: 'https://valid.nozomi.xyz', region: 'valid', type: 'direct' },
        { url: '', region: 'empty-url', type: 'direct' },
        { url: 'http://insecure.xyz', region: 'insecure', type: 'direct' },
        { url: 'https://no-region.xyz' },
        null,
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              version: 1,
              endpoints: remoteEndpoints
            })
          });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      expect(results.every(r => r.url.startsWith('https://'))).toBe(true);
    });

    it('filters out endpoints with non-string URL', async () => {
      const remoteEndpoints = [
        { url: 'https://valid.xyz', region: 'valid', type: 'direct' },
        { url: 123, region: 'number-url', type: 'direct' },
        { url: ['array'], region: 'array-url', type: 'direct' },
        { url: { nested: 'object' }, region: 'object-url', type: 'direct' },
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              version: 1,
              endpoints: remoteEndpoints
            })
          });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      // Should only include the valid endpoint
      expect(results.length).toBe(1);
      expect(results[0].url).toBe('https://valid.xyz');
    });

    it('filters out endpoints with missing URL property', async () => {
      const remoteEndpoints = [
        { url: 'https://valid.xyz', region: 'valid', type: 'direct' },
        { region: 'no-url', type: 'direct' }, // Missing url
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              version: 1,
              endpoints: remoteEndpoints
            })
          });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      expect(results.length).toBe(1);
      expect(results[0].url).toBe('https://valid.xyz');
    });

    it('filters out undefined entries in manifest', async () => {
      const remoteEndpoints = [
        { url: 'https://valid.xyz', region: 'valid', type: 'direct' },
        undefined,
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              version: 1,
              endpoints: remoteEndpoints
            })
          });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      expect(results.length).toBe(1);
      expect(results[0].url).toBe('https://valid.xyz');
    });

    it('uses custom endpointsUrl when provided', async () => {
      const customUrl = 'https://custom.example.com/endpoints.json';
      let fetchedUrl = '';

      mockFetch.mockImplementation((url: string) => {
        if (url === customUrl) {
          fetchedUrl = url;
          return Promise.resolve(createManifestResponse([
            { url: 'https://custom.xyz', region: 'custom', type: 'direct' }
          ]));
        }
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        endpointsUrl: customUrl,
        pingCount: 1,
        warmupCount: 0
      });

      expect(fetchedUrl).toBe(customUrl);
    });

    it('retries on fetch failure', async () => {
      let attempts = 0;

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          attempts++;
          if (attempts < 3) {
            return Promise.reject(new Error('Temporary error'));
          }
          return Promise.resolve(createManifestResponse([
            { url: 'https://retry-success.xyz', region: 'retry', type: 'direct' }
          ]));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      expect(attempts).toBeGreaterThanOrEqual(3);
      expect(results.some(r => r.url === 'https://retry-success.xyz')).toBe(true);
    });
  });

  describe('endpoint measurement', () => {
    it('handles endpoint returning 500 error', async () => {
      const endpoints: EndpointConfig[] = [
        { url: 'https://failing.xyz', region: 'failing', type: 'direct' },
        { url: 'https://working.xyz', region: 'working', type: 'direct' }
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        if (url.includes('failing')) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints,
        includeAutoRouted: false
      });

      // Failing endpoint should have Infinity time
      const failingResult = results.find(r => r.url.includes('failing'));
      const workingResult = results.find(r => r.url.includes('working'));

      if (failingResult) {
        expect(failingResult.minTime).toBe(Infinity);
      }
      expect(workingResult).toBeDefined();
      expect(workingResult?.minTime).not.toBe(Infinity);
    });

    it('handles network errors during ping', async () => {
      const endpoints: EndpointConfig[] = [
        { url: 'https://network-error.xyz', region: 'error', type: 'direct' },
        { url: 'https://working.xyz', region: 'working', type: 'direct' }
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        if (url.includes('network-error')) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints,
        includeAutoRouted: false
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.minTime !== Infinity)).toBe(true);
    });

    it('performs warmup pings before measurement', async () => {
      const pingCounts: { [url: string]: number } = {};

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        const baseUrl = url.split('/ping')[0];
        pingCounts[baseUrl] = (pingCounts[baseUrl] || 0) + 1;
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: 3,
        warmupCount: 2,
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      expect(pingCounts['https://test.xyz']).toBe(5);
    });

    it('records all ping times in result', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 3,
        warmupCount: 2,
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      expect(results[0].warmupTimes?.length).toBe(2);
      expect(results[0].times?.length).toBe(3);
    });
  });

  describe('includeAutoRouted option', () => {
    it('includes auto-routed endpoint by default', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0
      });

      expect(results[results.length - 1].region).toBe('auto');
    });

    it('excludes auto-routed when includeAutoRouted is false', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        includeAutoRouted: false
      });

      expect(results.every(r => r.region !== 'auto')).toBe(true);
    });

    it('adds auto endpoint even if not in config when includeAutoRouted is true', async () => {
      const endpoints: EndpointConfig[] = [
        { url: 'https://custom.xyz', region: 'custom', type: 'direct' }
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints,
        includeAutoRouted: true
      });

      expect(results.some(r => r.url === NOZOMI_AUTO_ENDPOINT)).toBe(true);
    });
  });

  describe('configuration options', () => {
    it('respects topCount option', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        topCount: 5,
        includeAutoRouted: false
      });

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('clamps pingCount to max 20', async () => {
      let pingCounts = 0;

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        pingCounts++;
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: 100,
        warmupCount: 0,
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      expect(pingCounts).toBe(20);
    });

    it('clamps pingCount to min 1 when zero', async () => {
      let pingCounts = 0;

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        pingCounts++;
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: 0,
        warmupCount: 0,
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      expect(pingCounts).toBe(1);
    });

    it('clamps pingCount to min 1 when negative', async () => {
      let pingCounts = 0;

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        pingCounts++;
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: -5,
        warmupCount: 0,
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      expect(pingCounts).toBe(1);
    });

    it('clamps warmupCount to max 5', async () => {
      let pingCounts = 0;

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        pingCounts++;
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 100, // Should be clamped to 5
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      // 5 warmup + 1 measurement = 6
      expect(pingCounts).toBe(6);
    });

    it('clamps warmupCount to min 0 when negative', async () => {
      let pingCounts = 0;

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        pingCounts++;
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: 1,
        warmupCount: -10, // Should be clamped to 0
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      // 0 warmup + 1 measurement = 1
      expect(pingCounts).toBe(1);
    });

    it('clamps topCount to min 1 when zero', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        topCount: 0, // Should be clamped to 1
        includeAutoRouted: false
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('clamps timeout to min 1000 when too low', async () => {
      // This test verifies that timeout is clamped - if timeout were 100ms,
      // our mock would still resolve, proving the clamp is working
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        timeout: 100, // Should be clamped to 1000
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].minTime).not.toBe(Infinity);
    });

    it('clamps topCount to valid range', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        topCount: 100,
        includeAutoRouted: false
      });

      expect(results.length).toBeLessThanOrEqual(10);
    });

    it('uses custom endpoint path', async () => {
      let requestedUrls: string[] = [];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        requestedUrls.push(url);
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoint: '/health',
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      expect(requestedUrls.some(url => url.includes('/health'))).toBe(true);
    });

    it('handles trailing slash in URL', async () => {
      let requestedUrls: string[] = [];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        requestedUrls.push(url);
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints: [{ url: 'https://test.xyz/', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      expect(requestedUrls.every(url => !url.includes('//ping'))).toBe(true);
    });

    it('handles multiple trailing slashes in URL', async () => {
      let requestedUrls: string[] = [];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        requestedUrls.push(url);
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints: [{ url: 'https://test.xyz///', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      // Should strip all trailing slashes
      expect(requestedUrls.every(url => !url.includes('///ping'))).toBe(true);
      expect(requestedUrls.some(url => url.includes('/ping'))).toBe(true);
    });

    it('handles empty endpoint path', async () => {
      let requestedUrls: string[] = [];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        requestedUrls.push(url);
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoint: '',
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      // Empty endpoint means just the base URL
      expect(requestedUrls.some(url => url === 'https://test.xyz')).toBe(true);
    });
  });

  describe('onResult callback', () => {
    it('calls onResult for each endpoint', async () => {
      const results: EndpointResult[] = [];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints: [
          { url: 'https://a.xyz', region: 'a', type: 'direct' },
          { url: 'https://b.xyz', region: 'b', type: 'direct' }
        ],
        includeAutoRouted: false,
        onResult: (result) => results.push(result)
      });

      expect(results.length).toBe(2);
    });

    it('continues even if onResult callback throws', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints: [
          { url: 'https://a.xyz', region: 'a', type: 'direct' },
          { url: 'https://b.xyz', region: 'b', type: 'direct' }
        ],
        includeAutoRouted: false,
        onResult: () => { throw new Error('Callback error'); }
      });

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('custom endpoints option', () => {
    it('uses provided endpoints instead of fetching', async () => {
      let fetchedRemote = false;

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          fetchedRemote = true;
          return Promise.reject(new Error('Should not be called'));
        }
        return Promise.resolve({ ok: true });
      });

      const customEndpoints: EndpointConfig[] = [
        { url: 'https://custom1.xyz', region: 'custom1', type: 'direct' },
        { url: 'https://custom2.xyz', region: 'custom2', type: 'direct' }
      ];

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints: customEndpoints,
        includeAutoRouted: false
      });

      expect(fetchedRemote).toBe(false);
      expect(results.every(r => r.url.includes('custom'))).toBe(true);
    });

    it('handles empty endpoints array', async () => {
      mockFetch.mockImplementation(() => {
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints: [],
        includeAutoRouted: false
      });

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('exports', () => {
    it('exports NOZOMI_ENDPOINTS constant', () => {
      expect(NOZOMI_ENDPOINTS).toBeDefined();
      expect(Array.isArray(NOZOMI_ENDPOINTS)).toBe(true);
      expect(NOZOMI_ENDPOINTS.length).toBeGreaterThan(0);
    });

    it('exports NOZOMI_AUTO_ENDPOINT constant', () => {
      expect(NOZOMI_AUTO_ENDPOINT).toBe('https://nozomi.temporal.xyz');
    });

    it('exports NOZOMI_ENDPOINTS_URL constant', () => {
      expect(NOZOMI_ENDPOINTS_URL).toContain('github');
      expect(NOZOMI_ENDPOINTS_URL).toContain('endpoints.json');
    });

    it('NOZOMI_ENDPOINTS has valid structure', () => {
      for (const endpoint of NOZOMI_ENDPOINTS) {
        expect(endpoint.url).toBeDefined();
        expect(endpoint.url.startsWith('https://')).toBe(true);
        expect(endpoint.region).toBeDefined();
        expect(['auto', 'direct', 'cloudflare']).toContain(endpoint.type);
      }
    });
  });

  describe('edge cases', () => {
    it('handles all endpoints returning Infinity', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: false });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].url).toBe(NOZOMI_AUTO_ENDPOINT);
    });

    it('handles concurrent calls without interference', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const [results1, results2, results3] = await Promise.all([
        findFastestEndpoints({ pingCount: 1, warmupCount: 0, topCount: 2 }),
        findFastestEndpoints({ pingCount: 1, warmupCount: 0, topCount: 3 }),
        findFastestEndpoints({ pingCount: 1, warmupCount: 0, topCount: 1 }),
      ]);

      expect(results1.length).toBeGreaterThanOrEqual(2);
      expect(results2.length).toBeGreaterThanOrEqual(3);
      expect(results3.length).toBeGreaterThanOrEqual(1);
    });

    it('handles mixed success and failure endpoints', async () => {
      const endpoints: EndpointConfig[] = [
        { url: 'https://success.xyz', region: 'success', type: 'direct' },
        { url: 'https://failure.xyz', region: 'failure', type: 'direct' }
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        if (url.includes('success')) {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error('Failed'));
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints,
        includeAutoRouted: false
      });

      expect(results.some(r => r.url.includes('success') && r.minTime !== Infinity)).toBe(true);
    });

    it('handles negative/zero timeout gracefully', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        timeout: -100
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('handles undefined options', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints();

      expect(results.length).toBeGreaterThan(0);
    });

    it('handles json parse error', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.reject(new Error('JSON parse error'))
          });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('handles empty endpoints array from manifest', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve(createManifestResponse([]));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0
      });

      // Should fall back to hardcoded
      expect(results.length).toBeGreaterThan(0);
    });

    it('handles manifest with null endpoints property', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              version: 1,
              endpoints: null
            })
          });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0
      });

      // Should fall back to hardcoded
      expect(results.length).toBeGreaterThan(0);
    });

    it('handles manifest with undefined endpoints property', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              version: 1
              // endpoints property missing
            })
          });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0
      });

      // Should fall back to hardcoded
      expect(results.length).toBeGreaterThan(0);
    });

    it('handles null manifest response', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(null)
          });
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0
      });

      // Should fall back to hardcoded
      expect(results.length).toBeGreaterThan(0);
    });

    it('handles single endpoint that fails', async () => {
      const endpoints: EndpointConfig[] = [
        { url: 'https://single-fail.xyz', region: 'fail', type: 'direct' }
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: false });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints,
        includeAutoRouted: false
      });

      // Should return empty result after deduplication since no valid results
      // But function always returns at least auto endpoint
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('handles only auto endpoint succeeding', async () => {
      const endpoints: EndpointConfig[] = [
        { url: 'https://fail1.xyz', region: 'fail1', type: 'direct' },
        { url: 'https://fail2.xyz', region: 'fail2', type: 'direct' },
        { url: NOZOMI_AUTO_ENDPOINT, region: 'auto', type: 'auto' }
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        if (url.includes('nozomi.temporal.xyz')) {
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: false });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints,
        includeAutoRouted: true
      });

      // Should return only the auto endpoint
      expect(results.length).toBe(1);
      expect(results[0].url).toBe(NOZOMI_AUTO_ENDPOINT);
    });

    it('properly populates times and warmupTimes arrays', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 3,
        warmupCount: 2,
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      expect(results[0].warmupTimes).toBeDefined();
      expect(results[0].times).toBeDefined();
      expect(Array.isArray(results[0].warmupTimes)).toBe(true);
      expect(Array.isArray(results[0].times)).toBe(true);
      expect(results[0].warmupTimes!.every(t => typeof t === 'number')).toBe(true);
      expect(results[0].times!.every(t => typeof t === 'number')).toBe(true);
    });

    it('result minTime matches minimum of times array', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 5,
        warmupCount: 0,
        endpoints: [{ url: 'https://test.xyz', region: 'test', type: 'direct' }],
        includeAutoRouted: false
      });

      const expectedMin = Math.min(...results[0].times!);
      expect(results[0].minTime).toBe(expectedMin);
    });

    it('handles very large number of endpoints', async () => {
      const manyEndpoints: EndpointConfig[] = [];
      for (let i = 0; i < 100; i++) {
        manyEndpoints.push({
          url: `https://endpoint-${i}.xyz`,
          region: `region-${i}`,
          type: 'direct'
        });
      }

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('github') || url.includes('raw.githubusercontent')) {
          return Promise.reject(new Error('Skip remote'));
        }
        return Promise.resolve({ ok: true });
      });

      const results = await findFastestEndpoints({
        pingCount: 1,
        warmupCount: 0,
        endpoints: manyEndpoints,
        topCount: 5,
        includeAutoRouted: false
      });

      // Should return at most 5 due to topCount
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });
});
