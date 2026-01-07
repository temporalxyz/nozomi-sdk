/**
 * Nozomi SDK - Endpoint Discovery
 *
 * Find the fastest Nozomi endpoints for optimal transaction submission.
 * Pings each endpoint multiple times to account for network jitter and
 * returns the fastest based on minimum response time.
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

/** Custom URL for remote endpoints (set via setEndpointsUrl or NOZOMI_ENDPOINTS_URL env var) */
let remoteEndpointsUrl: string | null = null;

/** Cached endpoints from remote fetch */
let cachedEndpoints: string[] | null = null;
let cacheExpiry: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Set the URL to fetch endpoints from (e.g., GCS bucket URL)
 * @param url - The URL to fetch endpoints JSON from, or null to disable remote fetching
 */
export function setEndpointsUrl(url: string | null): void {
  remoteEndpointsUrl = url;
  cachedEndpoints = null; // Clear cache when URL changes
  cacheExpiry = 0;
}

/**
 * Get the current remote endpoints URL
 */
export function getEndpointsUrl(): string | null {
  return remoteEndpointsUrl;
}

/**
 * Fetch endpoints from a remote URL
 * @param url - URL to fetch endpoints JSON from
 * @param timeout - Timeout in ms (defaults to 5000)
 * @returns Array of endpoint URLs, or null if fetch fails
 */
export async function fetchEndpoints(
  url: string,
  timeout: number = 5000
): Promise<string[] | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store'
    });

    if (!response.ok) {
      return null;
    }

    const manifest: EndpointsManifest = await response.json();
    return manifest.endpoints.map((e) => e.url);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get endpoints, trying remote first then falling back to hardcoded
 * Results are cached for 5 minutes
 *
 * Priority:
 * 1. Custom URL set via setEndpointsUrl()
 * 2. NOZOMI_ENDPOINTS_URL env var
 * 3. Default GitHub raw URL
 * 4. Hardcoded fallback endpoints
 */
export async function getEndpoints(): Promise<string[]> {
  // Check cache first
  if (cachedEndpoints && Date.now() < cacheExpiry) {
    return cachedEndpoints;
  }

  // Try remote URL: custom > env var > default GitHub URL
  const url = remoteEndpointsUrl
    || (typeof process !== 'undefined' ? process.env?.NOZOMI_ENDPOINTS_URL : null)
    || NOZOMI_ENDPOINTS_URL;

  const remote = await fetchEndpoints(url);
  if (remote && remote.length > 0) {
    cachedEndpoints = remote;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return remote;
  }

  // Fallback to hardcoded
  return [...NOZOMI_ENDPOINTS];
}

/** Auto-routed endpoint (always included as fallback by default) */
export const NOZOMI_AUTO_ENDPOINT = 'https://nozomi.temporal.xyz';

/** Hardcoded fallback endpoints */
export const NOZOMI_ENDPOINTS = [
  // Auto-routed
  NOZOMI_AUTO_ENDPOINT,

  // Direct endpoints
  'https://pit1.nozomi.temporal.xyz',  // Pittsburgh
  'https://tyo1.nozomi.temporal.xyz',  // Tokyo
  'https://sgp1.nozomi.temporal.xyz',  // Singapore
  'https://ewr1.nozomi.temporal.xyz',  // Newark
  'https://ams1.nozomi.temporal.xyz',  // Amsterdam
  'https://fra2.nozomi.temporal.xyz',  // Frankfurt
  'https://ash1.nozomi.temporal.xyz',  // Ashburn
  'https://lax1.nozomi.temporal.xyz',  // Los Angeles
  'https://lon1.nozomi.temporal.xyz',  // London

  // Cloudflare-routed endpoints
  'https://pit.nozomi.temporal.xyz',   // Pittsburgh (CF)
  'https://tyo.nozomi.temporal.xyz',   // Tokyo (CF)
  'https://sgp.nozomi.temporal.xyz',   // Singapore (CF)
  'https://ewr.nozomi.temporal.xyz',   // Newark (CF)
  'https://ams.nozomi.temporal.xyz',   // Amsterdam (CF)
  'https://fra.nozomi.temporal.xyz',   // Frankfurt (CF)
  'https://ash.nozomi.temporal.xyz',   // Ashburn (CF)
  'https://lax.nozomi.temporal.xyz',   // Los Angeles (CF)
  'https://lon.nozomi.temporal.xyz'    // London (CF)
] as const;

export interface EndpointResult {
  url: string;
  minTime: number;
  /** All ping times for this endpoint (excluding warmup) */
  times?: number[];
  /** Warmup request times (for debugging connection setup) */
  warmupTimes?: number[];
}

export interface FindFastestOptions {
  urls?: string[];
  pingCount?: number;
  topCount?: number;
  timeout?: number;
  endpoint?: string;
  /** Number of warmup requests before measuring (defaults to 2) */
  warmupCount?: number;
  /** Include auto-routed endpoint as final fallback (defaults to true) */
  includeAutoRouted?: boolean;
  /** Called when each endpoint completes testing */
  onResult?: (result: EndpointResult) => void;
}

const DEFAULT_OPTIONS = {
  pingCount: 5,
  topCount: 2,
  timeout: 5000,
  endpoint: '/ping',
  warmupCount: 2,
  includeAutoRouted: true
};

/**
 * Measure the response time for a single ping to an endpoint
 */
async function measurePing(url: string, endpoint: string, timeout: number): Promise<number> {
  const pingUrl = url.replace(/\/+$/, '') + endpoint;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const start = performance.now();

  try {
    const response = await fetch(pingUrl, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store'
    });

    if (!response.ok) {
      return Infinity;
    }

    return performance.now() - start;
  } catch {
    return Infinity;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Ping a URL multiple times and return the minimum response time
 */
async function pingUrl(
  url: string,
  options: typeof DEFAULT_OPTIONS
): Promise<EndpointResult> {
  try {
    // Warmup requests to establish connection (TLS handshake, TCP, DNS)
    const warmupTimes: number[] = [];
    for (let i = 0; i < options.warmupCount; i++) {
      const time = await measurePing(url, options.endpoint, options.timeout);
      warmupTimes.push(time);
    }

    // Measure actual ping times
    const times: number[] = [];
    for (let i = 0; i < options.pingCount; i++) {
      const time = await measurePing(url, options.endpoint, options.timeout);
      times.push(time);
    }

    // Handle edge case of empty times array
    const minTime = times.length > 0 ? Math.min(...times) : Infinity;

    return { url, minTime, times, warmupTimes };
  } catch {
    // If anything unexpected happens, mark endpoint as failed
    return { url, minTime: Infinity, times: [], warmupTimes: [] };
  }
}

/**
 * Find the fastest Nozomi endpoints.
 *
 * By default returns [2 fastest regional endpoints, auto-routed endpoint].
 * The auto-routed endpoint is always included as a fallback unless disabled.
 *
 * @param options - Configuration options
 * @param options.urls - Custom endpoint URLs (defaults to all Nozomi regions)
 * @param options.pingCount - Number of pings per endpoint (defaults to 5, uses minimum to handle jitter)
 * @param options.topCount - Number of fastest endpoints to return (defaults to 2, plus auto-routed)
 * @param options.timeout - Timeout per ping request in ms (defaults to 5000)
 * @param options.endpoint - Ping endpoint path (defaults to '/ping')
 * @param options.warmupCount - Number of warmup requests before measuring (defaults to 2, for TLS/TCP setup)
 * @param options.includeAutoRouted - Include auto-routed endpoint as final fallback (defaults to true)
 * @param options.onResult - Callback fired when each endpoint completes testing
 * @returns Fastest endpoints sorted by response time, with auto-routed appended
 *
 * @example
 * // Default: returns [fastest, 2nd fastest, auto-routed]
 * const fastest = await findFastestEndpoints();
 * // Returns: [{ url: 'https://ewr1.nozomi...', minTime: 2.2 }, { url: 'https://ash1.nozomi...', minTime: 5.7 }, { url: 'https://nozomi.temporal.xyz', minTime: 11.8 }]
 *
 * @example
 * // Disable auto-routed fallback
 * const fastest = await findFastestEndpoints({ includeAutoRouted: false, topCount: 3 });
 *
 * @example
 * // Use custom options with progress callback
 * const fastest = await findFastestEndpoints({
 *   topCount: 1,
 *   onResult: (result) => console.log(`${result.url}: ${result.minTime}ms`)
 * });
 */
export async function findFastestEndpoints(
  options: FindFastestOptions = {}
): Promise<EndpointResult[]> {
  const urls = options.urls || await getEndpoints();

  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('urls must be a non-empty array');
  }

  const config = { ...DEFAULT_OPTIONS, ...options };

  // Ping all endpoints in parallel, calling onResult as each completes
  // Each ping is wrapped to ensure one failure doesn't crash everything
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const result = await pingUrl(url, config);
        options.onResult?.(result);
        return result;
      } catch {
        // If ping fails unexpectedly, return failed result
        const failedResult: EndpointResult = { url, minTime: Infinity, times: [], warmupTimes: [] };
        options.onResult?.(failedResult);
        return failedResult;
      }
    })
  );

  // Filter out failed endpoints and sort by response time
  const validResults = results
    .filter(result => result.minTime !== Infinity)
    .sort((a, b) => a.minTime - b.minTime);

  // Extract region from URL (e.g., ewr1 -> ewr, pit -> pit, nozomi.temporal.xyz -> auto)
  const getRegion = (url: string): string => {
    const match = url.match(/https:\/\/([a-z]+)\d*\.nozomi/);
    if (match) return match[1]; // pit1 -> pit, ewr -> ewr
    if (url === NOZOMI_AUTO_ENDPOINT) return 'auto';
    return url; // fallback to full url
  };

  // Get top N fastest, deduplicating by region (excluding auto-routed if we'll add it separately)
  let topResults: EndpointResult[];
  if (config.includeAutoRouted) {
    // Exclude auto-routed from top results (we'll add it at the end)
    const nonAutoResults = validResults.filter(r => r.url !== NOZOMI_AUTO_ENDPOINT);

    // Deduplicate by region - keep only the fastest from each region
    const seenRegions = new Set<string>();
    const deduped: EndpointResult[] = [];
    for (const result of nonAutoResults) {
      const region = getRegion(result.url);
      if (!seenRegions.has(region)) {
        seenRegions.add(region);
        deduped.push(result);
      }
    }

    topResults = deduped.slice(0, config.topCount);

    // Find the auto-routed result and append it
    const autoResult = validResults.find(r => r.url === NOZOMI_AUTO_ENDPOINT);
    if (autoResult) {
      topResults.push(autoResult);
    }
  } else {
    // Deduplicate by region
    const seenRegions = new Set<string>();
    const deduped: EndpointResult[] = [];
    for (const result of validResults) {
      const region = getRegion(result.url);
      if (!seenRegions.has(region)) {
        seenRegions.add(region);
        deduped.push(result);
      }
    }
    topResults = deduped.slice(0, config.topCount);
  }

  return topResults;
}
