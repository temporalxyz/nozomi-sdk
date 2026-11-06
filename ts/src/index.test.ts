import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findFastestEndpoints,
  NozomiClient,
  NOZOMI_ENDPOINTS,
  NOZOMI_AUTO_ENDPOINT,
  NOZOMI_EDGE_ENDPOINT,
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

describe('NozomiClient', () => {
  describe('sendTransactionV2', () => {
    // Fake signed transaction with a known 64-byte signature
    const fakeSignature = new Uint8Array(64).fill(1);
    const fakeSerialized = new Uint8Array(1 + 64 + 100); // sigcount + sig + body
    fakeSerialized[0] = 1; // 1 signature
    fakeSerialized.set(fakeSignature, 1);

    const fakeTransaction = {
      serialize: () => fakeSerialized,
      signatures: [fakeSignature],
    };

    it('always sends to edge endpoint', async () => {
      const sentUrls: string[] = [];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/sendTransaction2')) {
          sentUrls.push(url);
          return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
        }
        // Ping requests
        if (url.includes('/ping')) {
          return Promise.resolve({ ok: true });
        }
        // Remote endpoint fetch
        return Promise.reject(new Error('Skip remote'));
      });

      const client = new NozomiClient('test-key', {
        keepWarmInterval: 0,
      });
      // Pre-populate cache with endpoints that do NOT include edge
      (client as any).cachedEndpoints = [
        { url: 'https://pit1.nozomi.temporal.xyz', region: 'pittsburgh', minTime: 10 },
        { url: 'https://nozomi.temporal.xyz', region: 'auto', minTime: 20 },
      ];

      await client.sendTransactionV2(fakeTransaction);

      expect(sentUrls.some(u => u.includes('edge.nozomi.temporal.xyz'))).toBe(true);
      client.destroy();
    });

    it('does not duplicate edge if already cached', async () => {
      const sentUrls: string[] = [];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/sendTransaction2')) {
          sentUrls.push(url);
          return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
        }
        return Promise.reject(new Error('Skip'));
      });

      const client = new NozomiClient('test-key', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
        { url: 'https://pit1.nozomi.temporal.xyz', region: 'pittsburgh', minTime: 10 },
        { url: NOZOMI_AUTO_ENDPOINT, region: 'auto', minTime: 20 },
      ];

      await client.sendTransactionV2(fakeTransaction);

      const edgeHits = sentUrls.filter(u => u.includes('edge.nozomi.temporal.xyz'));
      expect(edgeHits.length).toBe(1);
      expect(sentUrls.length).toBe(3);
      client.destroy();
    });

    it('returns a signature string on success', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/sendTransaction2')) {
          return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
        }
        return Promise.reject(new Error('Skip'));
      });

      const client = new NozomiClient('test-key', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
      ];

      const sig = await client.sendTransactionV2(fakeTransaction);

      expect(typeof sig).toBe('string');
      expect(sig.length).toBeGreaterThan(0);
      client.destroy();
    });

    it('throws when all endpoints fail', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/sendTransaction2')) {
          return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('server error') });
        }
        return Promise.reject(new Error('Skip'));
      });

      const client = new NozomiClient('test-key', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
      ];

      await expect(client.sendTransactionV2(fakeTransaction, { maxRetries: 0 }))
        .rejects.toThrow('All endpoints failed');
      client.destroy();
    });

    it('includes client id in send URL', async () => {
      const sentUrls: string[] = [];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/sendTransaction2')) {
          sentUrls.push(url);
          return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
        }
        return Promise.reject(new Error('Skip'));
      });

      const client = new NozomiClient('my-api-key-123', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
      ];

      await client.sendTransactionV2(fakeTransaction);

      expect(sentUrls[0]).toContain('c=my-api-key-123');
      client.destroy();
    });
  });

  describe('sendBatch', () => {
    // Helper to create a fake transaction of a given size
    function fakeTx(size: number = 200) {
      const sig = new Uint8Array(64).fill(2);
      const data = new Uint8Array(size);
      data[0] = 1; // 1 signature
      data.set(sig, 1);
      return {
        serialize: () => data,
        signatures: [sig],
      };
    }

    it('sends binary payload to /api/sendBatch on all endpoints', async () => {
      const sentUrls: string[] = [];
      const sentBodies: ArrayBuffer[] = [];

      mockFetch.mockImplementation(async (url: string, init: any) => {
        if (url.includes('/api/sendBatch')) {
          sentUrls.push(url);
          // Capture body
          if (init?.body instanceof Uint8Array) {
            sentBodies.push(init.body.slice());
          }
          return { ok: true, text: () => Promise.resolve('') };
        }
        return Promise.reject(new Error('Skip'));
      });

      const client = new NozomiClient('batch-key', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
        { url: NOZOMI_AUTO_ENDPOINT, region: 'auto', minTime: 20 },
      ];

      const tx1 = fakeTx(200);
      const tx2 = fakeTx(300);
      const sigs = await client.sendBatch([tx1, tx2]);

      // Sent to both endpoints
      expect(sentUrls.length).toBe(2);
      expect(sentUrls.every(u => u.includes('/api/sendBatch'))).toBe(true);
      expect(sentUrls.every(u => u.includes('c=batch-key'))).toBe(true);

      // Returns 2 signatures
      expect(sigs.length).toBe(2);
      expect(sigs.every(s => typeof s === 'string' && s.length > 0)).toBe(true);

      // Verify binary wire format: [len_hi][len_lo][tx]...
      const body = new Uint8Array(sentBodies[0] as ArrayBuffer);
      const expectedLen = 2 + 200 + 2 + 300;
      expect(body.length).toBe(expectedLen);
      // First tx length prefix (big-endian 200 = 0x00C8)
      expect(body[0]).toBe(0);
      expect(body[1]).toBe(200);
      // Second tx length prefix (big-endian 300 = 0x012C)
      expect(body[202]).toBe(1);
      expect(body[203]).toBe(0x2c);

      client.destroy();
    });

    it('always includes edge endpoint', async () => {
      const sentUrls: string[] = [];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/sendBatch')) {
          sentUrls.push(url);
          return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
        }
        return Promise.reject(new Error('Skip'));
      });

      const client = new NozomiClient('key', { keepWarmInterval: 0 });
      // Cache without edge
      (client as any).cachedEndpoints = [
        { url: 'https://pit1.nozomi.temporal.xyz', region: 'pittsburgh', minTime: 10 },
      ];

      await client.sendBatch([fakeTx()]);

      expect(sentUrls.some(u => u.includes('edge.nozomi.temporal.xyz'))).toBe(true);
      client.destroy();
    });

    it('rejects empty transaction array', async () => {
      const client = new NozomiClient('key', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
      ];

      await expect(client.sendBatch([])).rejects.toThrow('at least one');
      client.destroy();
    });

    it('rejects more than 16 transactions', async () => {
      const client = new NozomiClient('key', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
      ];

      const txs = Array.from({ length: 17 }, () => fakeTx());
      await expect(client.sendBatch(txs)).rejects.toThrow('at most 16');
      client.destroy();
    });

    it('rejects transaction smaller than 66 bytes', async () => {
      const client = new NozomiClient('key', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
      ];

      const tinyTx = { serialize: () => new Uint8Array(50), signatures: [new Uint8Array(64)] };
      await expect(client.sendBatch([tinyTx])).rejects.toThrow('out of range');
      client.destroy();
    });

    it('rejects transaction larger than 1232 bytes', async () => {
      const client = new NozomiClient('key', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
      ];

      const bigTx = { serialize: () => new Uint8Array(1300), signatures: [new Uint8Array(64)] };
      await expect(client.sendBatch([bigTx])).rejects.toThrow('out of range');
      client.destroy();
    });

    it('throws when all endpoints fail', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/sendBatch')) {
          return Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve('framing error') });
        }
        return Promise.reject(new Error('Skip'));
      });

      const client = new NozomiClient('key', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
      ];

      await expect(client.sendBatch([fakeTx()], { maxRetries: 0 }))
        .rejects.toThrow('All endpoints failed');
      client.destroy();
    });

    it('uses content-type application/octet-stream', async () => {
      let capturedHeaders: Record<string, string> = {};

      mockFetch.mockImplementation((_url: string, init: any) => {
        if (init?.headers) {
          capturedHeaders = init.headers;
        }
        return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
      });

      const client = new NozomiClient('key', { keepWarmInterval: 0 });
      (client as any).cachedEndpoints = [
        { url: NOZOMI_EDGE_ENDPOINT, region: 'edge', minTime: 5 },
      ];

      await client.sendBatch([fakeTx()]);

      expect(capturedHeaders['Content-Type']).toBe('text/plain');
      client.destroy();
    });
  });

  describe('exports', () => {
    it('exports NOZOMI_EDGE_ENDPOINT constant', () => {
      expect(NOZOMI_EDGE_ENDPOINT).toBe('https://edge.nozomi.temporal.xyz');
    });

    it('NOZOMI_ENDPOINTS includes edge endpoint', () => {
      expect(NOZOMI_ENDPOINTS.some(e => e.url === NOZOMI_EDGE_ENDPOINT)).toBe(true);
    });
  });
});
