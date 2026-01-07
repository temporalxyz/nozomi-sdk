/**
 * Nozomi SDK - Endpoint Discovery
 *
 * Find the fastest Nozomi endpoints for optimal transaction submission.
 */

/** Remote endpoints JSON structure */
export interface EndpointConfig {
  url: string;
  region: string;
  type: 'auto' | 'direct' | 'cloudflare';
}

export interface EndpointsManifest {
  version: number;
  updated: string;
  endpoints: EndpointConfig[];
}

/** Default GitHub raw URL for remote endpoints */
export const NOZOMI_ENDPOINTS_URL = 'https://raw.githubusercontent.com/temporalxyz/nozomi-sdk/main/endpoints.json';

/** Auto-routed endpoint (always included as fallback by default) */
export const NOZOMI_AUTO_ENDPOINT = 'https://nozomi.temporal.xyz';

/** Hardcoded fallback endpoints */
export const NOZOMI_ENDPOINTS = [
  NOZOMI_AUTO_ENDPOINT,
  'https://pit1.nozomi.temporal.xyz',
  'https://tyo1.nozomi.temporal.xyz',
  'https://sgp1.nozomi.temporal.xyz',
  'https://ewr1.nozomi.temporal.xyz',
  'https://ams1.nozomi.temporal.xyz',
  'https://fra2.nozomi.temporal.xyz',
  'https://ash1.nozomi.temporal.xyz',
  'https://lax1.nozomi.temporal.xyz',
  'https://lon1.nozomi.temporal.xyz',
  'https://pit.nozomi.temporal.xyz',
  'https://tyo.nozomi.temporal.xyz',
  'https://sgp.nozomi.temporal.xyz',
  'https://ewr.nozomi.temporal.xyz',
  'https://ams.nozomi.temporal.xyz',
  'https://fra.nozomi.temporal.xyz',
  'https://ash.nozomi.temporal.xyz',
  'https://lax.nozomi.temporal.xyz',
  'https://lon.nozomi.temporal.xyz'
] as const;

export interface EndpointResult {
  url: string;
  minTime: number;
  times?: number[];
  warmupTimes?: number[];
}

export interface FindFastestOptions {
  urls?: string[];
  endpointsUrl?: string;
  pingCount?: number;
  topCount?: number;
  timeout?: number;
  endpoint?: string;
  warmupCount?: number;
  includeAutoRouted?: boolean;
  onResult?: (result: EndpointResult) => void;
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchEndpointsFromUrl(url: string, timeout: number, retries: number): Promise<string[] | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(attempt * 500);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timeoutId);

      if (!response.ok) continue;

      const manifest: EndpointsManifest = await response.json();
      if (manifest?.endpoints && Array.isArray(manifest.endpoints)) {
        const urls = manifest.endpoints
          .map(e => e?.url)
          .filter((u): u is string => typeof u === 'string' && u.startsWith('https://'));
        if (urls.length > 0) return urls;
      }
    } catch {
      clearTimeout(timeoutId);
    }
  }
  return null;
}

async function getEndpointUrls(endpointsUrl?: string): Promise<string[]> {
  const url = endpointsUrl || NOZOMI_ENDPOINTS_URL;
  const remote = await fetchEndpointsFromUrl(url, 3000, 2);
  return remote && remote.length > 0 ? remote : [...NOZOMI_ENDPOINTS];
}

async function measurePing(url: string, endpoint: string, timeout: number): Promise<number> {
  const pingUrl = url.replace(/\/+$/, '') + endpoint;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const start = performance.now();

  try {
    const response = await fetch(pingUrl, { method: 'GET', signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeoutId);
    return response.ok ? performance.now() - start : Infinity;
  } catch {
    clearTimeout(timeoutId);
    return Infinity;
  }
}

async function pingEndpoint(url: string, pingCount: number, warmupCount: number, endpoint: string, timeout: number): Promise<EndpointResult> {
  const warmupTimes: number[] = [];
  for (let i = 0; i < warmupCount; i++) {
    warmupTimes.push(await measurePing(url, endpoint, timeout));
  }

  const times: number[] = [];
  for (let i = 0; i < pingCount; i++) {
    times.push(await measurePing(url, endpoint, timeout));
  }

  const minTime = times.length > 0 ? Math.min(...times) : Infinity;
  return { url, minTime, times, warmupTimes };
}

function getRegion(url: string): string {
  const match = url.match(/https:\/\/([a-z]+)\d*\.nozomi/);
  if (match) return match[1];
  if (url === NOZOMI_AUTO_ENDPOINT) return 'auto';
  return url;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Find the fastest Nozomi endpoints.
 *
 * NEVER THROWS - always returns at least the auto-routed endpoint.
 *
 * By default returns [2 fastest regional endpoints, auto-routed endpoint].
 */
export async function findFastestEndpoints(options: FindFastestOptions = {}): Promise<EndpointResult[]> {
  try {
    // Get URLs
    let urls = options.urls || await getEndpointUrls(options.endpointsUrl);
    if (!Array.isArray(urls) || urls.length === 0) urls = [...NOZOMI_ENDPOINTS];
    urls = urls.filter(u => typeof u === 'string' && u.startsWith('https://'));
    if (urls.length === 0) urls = [...NOZOMI_ENDPOINTS];

    // Config with defaults
    const pingCount = Math.max(1, Math.min(20, options.pingCount ?? 5));
    const topCount = Math.max(1, Math.min(10, options.topCount ?? 2));
    const timeout = Math.max(1000, Math.min(30000, options.timeout ?? 5000));
    const warmupCount = Math.max(0, Math.min(5, options.warmupCount ?? 2));
    const endpoint = options.endpoint ?? '/ping';
    const includeAutoRouted = options.includeAutoRouted ?? true;

    // Ping all endpoints in parallel
    const results = await Promise.all(
      urls.map(async url => {
        const result = await pingEndpoint(url, pingCount, warmupCount, endpoint, timeout);
        try { options.onResult?.(result); } catch { /* ignore callback errors */ }
        return result;
      })
    );

    // Filter and sort
    const validResults = results
      .filter(r => r.minTime !== Infinity && isFinite(r.minTime))
      .sort((a, b) => a.minTime - b.minTime);

    // Deduplicate by region
    let topResults: EndpointResult[];

    if (includeAutoRouted) {
      const nonAutoResults = validResults.filter(r => r.url !== NOZOMI_AUTO_ENDPOINT);
      const seenRegions = new Set<string>();
      const deduped: EndpointResult[] = [];

      for (const result of nonAutoResults) {
        const region = getRegion(result.url);
        if (!seenRegions.has(region)) {
          seenRegions.add(region);
          deduped.push(result);
        }
      }

      topResults = deduped.slice(0, topCount);

      const autoResult = validResults.find(r => r.url === NOZOMI_AUTO_ENDPOINT);
      topResults.push(autoResult ?? { url: NOZOMI_AUTO_ENDPOINT, minTime: Infinity, times: [], warmupTimes: [] });
    } else {
      const seenRegions = new Set<string>();
      const deduped: EndpointResult[] = [];

      for (const result of validResults) {
        const region = getRegion(result.url);
        if (!seenRegions.has(region)) {
          seenRegions.add(region);
          deduped.push(result);
        }
      }

      topResults = deduped.slice(0, topCount);
    }

    // Always return at least one endpoint
    if (topResults.length === 0) {
      topResults = [{ url: NOZOMI_AUTO_ENDPOINT, minTime: Infinity, times: [], warmupTimes: [] }];
    }

    return topResults;
  } catch {
    return [{ url: NOZOMI_AUTO_ENDPOINT, minTime: Infinity, times: [], warmupTimes: [] }];
  }
}
