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

/** Hardcoded fallback endpoints with regions */
export const NOZOMI_ENDPOINTS: EndpointConfig[] = [
  { url: NOZOMI_AUTO_ENDPOINT, region: 'auto', type: 'auto' },
  { url: 'https://pit1.nozomi.temporal.xyz', region: 'pittsburgh', type: 'direct' },
  { url: 'https://tyo1.nozomi.temporal.xyz', region: 'tokyo', type: 'direct' },
  { url: 'https://sgp1.nozomi.temporal.xyz', region: 'singapore', type: 'direct' },
  { url: 'https://ewr1.nozomi.temporal.xyz', region: 'newark', type: 'direct' },
  { url: 'https://ams1.nozomi.temporal.xyz', region: 'amsterdam', type: 'direct' },
  { url: 'https://fra2.nozomi.temporal.xyz', region: 'frankfurt', type: 'direct' },
  { url: 'https://ash1.nozomi.temporal.xyz', region: 'ashburn', type: 'direct' },
  { url: 'https://lax1.nozomi.temporal.xyz', region: 'los-angeles', type: 'direct' },
  { url: 'https://lon1.nozomi.temporal.xyz', region: 'london', type: 'direct' },
  { url: 'https://pit.nozomi.temporal.xyz', region: 'pittsburgh', type: 'cloudflare' },
  { url: 'https://tyo.nozomi.temporal.xyz', region: 'tokyo', type: 'cloudflare' },
  { url: 'https://sgp.nozomi.temporal.xyz', region: 'singapore', type: 'cloudflare' },
  { url: 'https://ewr.nozomi.temporal.xyz', region: 'newark', type: 'cloudflare' },
  { url: 'https://ams.nozomi.temporal.xyz', region: 'amsterdam', type: 'cloudflare' },
  { url: 'https://fra.nozomi.temporal.xyz', region: 'frankfurt', type: 'cloudflare' },
  { url: 'https://ash.nozomi.temporal.xyz', region: 'ashburn', type: 'cloudflare' },
  { url: 'https://lax.nozomi.temporal.xyz', region: 'los-angeles', type: 'cloudflare' },
  { url: 'https://lon.nozomi.temporal.xyz', region: 'london', type: 'cloudflare' }
];

export interface EndpointResult {
  url: string;
  region: string;
  minTime: number;
  times?: number[];
  warmupTimes?: number[];
}

export interface FindFastestOptions {
  endpoints?: EndpointConfig[];
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

async function fetchEndpointsFromUrl(url: string, timeout: number, retries: number): Promise<EndpointConfig[] | null> {
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
        const valid = manifest.endpoints.filter(
          e => e?.url && typeof e.url === 'string' && e.url.startsWith('https://') && e.region
        );
        if (valid.length > 0) return valid;
      }
    } catch {
      clearTimeout(timeoutId);
    }
  }
  return null;
}

async function getEndpointConfigs(endpointsUrl?: string): Promise<EndpointConfig[]> {
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

async function pingEndpoint(
  config: EndpointConfig,
  pingCount: number,
  warmupCount: number,
  endpoint: string,
  timeout: number
): Promise<EndpointResult> {
  const warmupTimes: number[] = [];
  for (let i = 0; i < warmupCount; i++) {
    warmupTimes.push(await measurePing(config.url, endpoint, timeout));
  }

  const times: number[] = [];
  for (let i = 0; i < pingCount; i++) {
    times.push(await measurePing(config.url, endpoint, timeout));
  }

  const minTime = times.length > 0 ? Math.min(...times) : Infinity;
  return { url: config.url, region: config.region, minTime, times, warmupTimes };
}

// ============================================================================
// PUBLIC API
// ============================================================================

export interface NozomiClientOptions {
  /** Default number of measurement pings (1-20, default: 5) */
  pingCount?: number;
  /** Default number of warmup pings (0-5, default: 2) */
  warmupCount?: number;
  /** Default number of top endpoints to return (1-10, default: 2) */
  topCount?: number;
  /** Default timeout per ping in ms (1000-30000, default: 5000) */
  timeout?: number;
  /** Default ping endpoint path (default: '/ping') */
  endpoint?: string;
  /** Include auto-routed endpoint in results (default: true) */
  includeAutoRouted?: boolean;
  /** Custom endpoint configs (skips remote fetch) */
  endpoints?: EndpointConfig[];
  /** Custom endpoints URL */
  endpointsUrl?: string;
}

/**
 * Nozomi Client for interacting with Nozomi endpoints.
 *
 * Provides a convenient way to find fastest endpoints and build RPC URLs
 * with your API key automatically included.
 */
export class NozomiClient {
  private readonly clientId: string;
  private readonly defaultOptions: NozomiClientOptions;
  private cachedEndpoints: EndpointResult[] | null = null;

  /**
   * Create a new NozomiClient.
   *
   * @param clientId - Your Nozomi API key
   * @param options - Default options for endpoint discovery
   */
  constructor(clientId: string, options: NozomiClientOptions = {}) {
    this.clientId = clientId;
    this.defaultOptions = options;
  }

  /**
   * Find the fastest Nozomi endpoints.
   *
   * NEVER THROWS - always returns at least the auto-routed endpoint.
   *
   * @param options - Override default options for this call
   */
  async findFastestEndpoints(options: FindFastestOptions = {}): Promise<EndpointResult[]> {
    const mergedOptions = { ...this.defaultOptions, ...options };
    return findFastestEndpoints(mergedOptions);
  }

  /**
   * Get the RPC URL for an endpoint with API key included.
   *
   * @param endpoint - EndpointResult object or URL string
   */
  getEndpointUrl(endpoint: EndpointResult | string): string {
    const url = typeof endpoint === 'string' ? endpoint : endpoint.url;
    return `${url.replace(/\/+$/, '')}/?c=${this.clientId}`;
  }

  /**
   * Find the fastest endpoint and return its RPC URL with API key.
   *
   * NEVER THROWS - always returns a valid URL.
   *
   * @param options - Override default options for this call
   */
  async getFastestEndpointUrl(options: FindFastestOptions = {}): Promise<string> {
    const mergedOptions = { ...this.defaultOptions, ...options, topCount: 1 };
    const [fastest] = await findFastestEndpoints(mergedOptions);
    return this.getEndpointUrl(fastest);
  }

  /**
   * Get cached endpoints or fetch if not cached.
   *
   * Call refresh() to update the cache.
   */
  async getEndpoints(options: FindFastestOptions = {}): Promise<EndpointResult[]> {
    if (!this.cachedEndpoints) {
      this.cachedEndpoints = await this.findFastestEndpoints(options);
    }
    return this.cachedEndpoints;
  }

  /**
   * Refresh the cached endpoints.
   */
  async refresh(options: FindFastestOptions = {}): Promise<EndpointResult[]> {
    this.cachedEndpoints = await this.findFastestEndpoints(options);
    return this.cachedEndpoints;
  }

  /**
   * Clear the cached endpoints.
   */
  clearCache(): void {
    this.cachedEndpoints = null;
  }
}

/**
 * Find the fastest Nozomi endpoints.
 *
 * NEVER THROWS - always returns at least the auto-routed endpoint.
 *
 * By default returns [2 fastest regional endpoints, auto-routed endpoint].
 */
export async function findFastestEndpoints(options: FindFastestOptions = {}): Promise<EndpointResult[]> {
  try {
    // Get endpoint configs
    let configs = options.endpoints || await getEndpointConfigs(options.endpointsUrl);
    if (!Array.isArray(configs) || configs.length === 0) configs = [...NOZOMI_ENDPOINTS];

    // Config with defaults
    const pingCount = Math.max(1, Math.min(20, options.pingCount ?? 5));
    const topCount = Math.max(1, Math.min(10, options.topCount ?? 2));
    const timeout = Math.max(1000, Math.min(30000, options.timeout ?? 5000));
    const warmupCount = Math.max(0, Math.min(5, options.warmupCount ?? 2));
    const endpoint = options.endpoint ?? '/ping';
    const includeAutoRouted = options.includeAutoRouted ?? true;

    // Ping all endpoints in parallel
    const results = await Promise.all(
      configs.map(async config => {
        const result = await pingEndpoint(config, pingCount, warmupCount, endpoint, timeout);
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
      const nonAutoResults = validResults.filter(r => r.region !== 'auto');
      const seenRegions = new Set<string>();
      const deduped: EndpointResult[] = [];

      for (const result of nonAutoResults) {
        if (!seenRegions.has(result.region)) {
          seenRegions.add(result.region);
          deduped.push(result);
        }
      }

      topResults = deduped.slice(0, topCount);

      const autoResult = validResults.find(r => r.region === 'auto');
      topResults.push(autoResult ?? { url: NOZOMI_AUTO_ENDPOINT, region: 'auto', minTime: Infinity, times: [], warmupTimes: [] });
    } else {
      const seenRegions = new Set<string>();
      const deduped: EndpointResult[] = [];

      for (const result of validResults) {
        if (!seenRegions.has(result.region)) {
          seenRegions.add(result.region);
          deduped.push(result);
        }
      }

      topResults = deduped.slice(0, topCount);
    }

    // Always return at least one endpoint
    if (topResults.length === 0) {
      topResults = [{ url: NOZOMI_AUTO_ENDPOINT, region: 'auto', minTime: Infinity, times: [], warmupTimes: [] }];
    }

    return topResults;
  } catch {
    return [{ url: NOZOMI_AUTO_ENDPOINT, region: 'auto', minTime: Infinity, times: [], warmupTimes: [] }];
  }
}
