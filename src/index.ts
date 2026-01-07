/**
 * Nozomi SDK - Endpoint Discovery
 *
 * Find the fastest Nozomi endpoints for optimal transaction submission.
 * Pings each endpoint multiple times to account for network jitter and
 * returns the fastest based on minimum response time.
 *
 * RESILIENCE GUARANTEES:
 * - Never throws exceptions - always returns valid results
 * - Retry with backoff on remote fetch
 * - Always falls back to hardcoded endpoints
 * - Always returns at least the auto-routed endpoint
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

/** Endpoint failure tracking - remember which endpoints failed recently */
const failedEndpoints = new Map<string, number>(); // url -> failure timestamp
const FAILURE_COOLDOWN_MS = 60 * 1000; // Skip failed endpoints for 1 minute

/**
 * Check if an endpoint is in cooldown (failed recently)
 */
function isEndpointInCooldown(url: string): boolean {
  const failedAt = failedEndpoints.get(url);
  if (!failedAt) return false;
  if (Date.now() - failedAt > FAILURE_COOLDOWN_MS) {
    failedEndpoints.delete(url); // Cooldown expired
    return false;
  }
  return true;
}

/**
 * Mark an endpoint as failed
 */
function markEndpointFailed(url: string): void {
  failedEndpoints.set(url, Date.now());
}

/**
 * Clear failure status for an endpoint (it succeeded)
 */
function markEndpointSucceeded(url: string): void {
  failedEndpoints.delete(url);
}

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
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch endpoints from a remote URL with retry and backoff
 * NEVER THROWS - returns null on failure
 *
 * @param url - URL to fetch endpoints JSON from
 * @param timeout - Timeout in ms per attempt (defaults to 3000)
 * @param retries - Number of retry attempts (defaults to 2)
 * @returns Array of endpoint URLs, or null if all attempts fail
 */
export async function fetchEndpoints(
  url: string,
  timeout: number = 3000,
  retries: number = 2
): Promise<string[] | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Exponential backoff: 0ms, 500ms, 1000ms
    if (attempt > 0) {
      await sleep(attempt * 500);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store'
      });

      if (!response.ok) {
        clearTimeout(timeoutId);
        continue; // Retry on non-2xx
      }

      const manifest: EndpointsManifest = await response.json();
      clearTimeout(timeoutId);

      // Validate response structure
      if (manifest?.endpoints && Array.isArray(manifest.endpoints)) {
        const urls = manifest.endpoints
          .map((e) => e?.url)
          .filter((u): u is string => typeof u === 'string' && u.startsWith('https://'));
        if (urls.length > 0) {
          return urls;
        }
      }
    } catch {
      clearTimeout(timeoutId);
      // Continue to retry
    }
  }

  return null;
}

/**
 * Get endpoints - tries remote first, falls back to cache, then hardcoded
 *
 * NEVER THROWS - always returns valid endpoints
 *
 * Priority:
 * 1. Fresh cache (instant return)
 * 2. Remote fetch with retry
 * 3. Stale cache (if remote fails)
 * 4. Hardcoded fallback endpoints
 */
export async function getEndpoints(): Promise<string[]> {
  try {
    const now = Date.now();

    // Fresh cache - return immediately
    if (cachedEndpoints && cachedEndpoints.length > 0 && now < cacheExpiry) {
      return [...cachedEndpoints];
    }

    // Get the URL to fetch from
    const url = remoteEndpointsUrl
      || (typeof process !== 'undefined' ? process.env?.NOZOMI_ENDPOINTS_URL : null)
      || NOZOMI_ENDPOINTS_URL;

    // Try remote fetch
    const remote = await fetchEndpoints(url);
    if (remote && remote.length > 0) {
      cachedEndpoints = remote;
      cacheExpiry = now + CACHE_TTL_MS;
      return [...cachedEndpoints];
    }

    // Remote failed - use stale cache if available
    if (cachedEndpoints && cachedEndpoints.length > 0) {
      return [...cachedEndpoints];
    }
  } catch {
    // Fall through to hardcoded
  }

  // Ultimate fallback - hardcoded endpoints
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
  /** True if endpoint was skipped due to recent failure cooldown */
  skipped?: boolean;
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
 * NEVER THROWS - returns Infinity on any failure
 */
async function measurePing(url: string, endpoint: string, timeout: number): Promise<number> {
  try {
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

      clearTimeout(timeoutId);

      if (!response.ok) {
        return Infinity;
      }

      return performance.now() - start;
    } catch {
      clearTimeout(timeoutId);
      return Infinity;
    }
  } catch {
    return Infinity;
  }
}

/**
 * Ping a URL multiple times and return the minimum response time
 * NEVER THROWS - returns failed result on any error
 */
async function pingUrl(
  url: string,
  options: typeof DEFAULT_OPTIONS
): Promise<EndpointResult> {
  try {
    // Skip endpoints in cooldown
    if (isEndpointInCooldown(url)) {
      return { url, minTime: Infinity, times: [], warmupTimes: [], skipped: true };
    }

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

    // Track success/failure for future cooldown
    if (minTime === Infinity || times.every(t => t === Infinity)) {
      markEndpointFailed(url);
    } else {
      markEndpointSucceeded(url);
    }

    return { url, minTime, times, warmupTimes };
  } catch {
    markEndpointFailed(url);
    return { url, minTime: Infinity, times: [], warmupTimes: [] };
  }
}

/**
 * Safely call the onResult callback
 */
function safeOnResult(callback: ((result: EndpointResult) => void) | undefined, result: EndpointResult): void {
  if (!callback) return;
  try {
    callback(result);
  } catch {
    // User's callback threw - ignore to prevent breaking the SDK
  }
}

/**
 * Extract region from URL (e.g., ewr1 -> ewr, pit -> pit, nozomi.temporal.xyz -> auto)
 */
function getRegion(url: string): string {
  try {
    const match = url.match(/https:\/\/([a-z]+)\d*\.nozomi/);
    if (match) return match[1]; // pit1 -> pit, ewr -> ewr
    if (url === NOZOMI_AUTO_ENDPOINT) return 'auto';
    return url; // fallback to full url
  } catch {
    return url;
  }
}

/**
 * Find the fastest Nozomi endpoints.
 *
 * NEVER THROWS - always returns at least the auto-routed endpoint.
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
 */
export async function findFastestEndpoints(
  options: FindFastestOptions = {}
): Promise<EndpointResult[]> {
  try {
    // Get URLs - never throws, always returns valid array
    let urls: string[];
    try {
      urls = options.urls || await getEndpoints();
    } catch {
      urls = [...NOZOMI_ENDPOINTS];
    }

    // Validate and sanitize URLs
    if (!Array.isArray(urls) || urls.length === 0) {
      urls = [...NOZOMI_ENDPOINTS];
    }

    // Filter to valid URLs only
    urls = urls.filter(u => typeof u === 'string' && u.startsWith('https://'));
    if (urls.length === 0) {
      urls = [...NOZOMI_ENDPOINTS];
    }

    const config = { ...DEFAULT_OPTIONS, ...options };

    // Sanitize config values
    config.pingCount = Math.max(1, Math.min(20, config.pingCount || 5));
    config.topCount = Math.max(1, Math.min(10, config.topCount || 2));
    config.timeout = Math.max(1000, Math.min(30000, config.timeout || 5000));
    config.warmupCount = Math.max(0, Math.min(5, config.warmupCount || 2));

    // Ping all endpoints in parallel, calling onResult as each completes
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const result = await pingUrl(url, config);
          safeOnResult(options.onResult, result);
          return result;
        } catch {
          const failedResult: EndpointResult = { url, minTime: Infinity, times: [], warmupTimes: [] };
          safeOnResult(options.onResult, failedResult);
          return failedResult;
        }
      })
    );

    // Filter out failed endpoints and sort by response time
    const validResults = results
      .filter(result => result.minTime !== Infinity && isFinite(result.minTime))
      .sort((a, b) => a.minTime - b.minTime);

    // Get top N fastest, deduplicating by region
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

      // Find the auto-routed result and append it, or create a placeholder
      const autoResult = validResults.find(r => r.url === NOZOMI_AUTO_ENDPOINT);
      if (autoResult) {
        topResults.push(autoResult);
      } else {
        // Auto endpoint didn't respond, but still include it as fallback
        topResults.push({ url: NOZOMI_AUTO_ENDPOINT, minTime: Infinity, times: [], warmupTimes: [] });
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

    // GUARANTEE: Always return at least one endpoint
    if (topResults.length === 0) {
      topResults = [{ url: NOZOMI_AUTO_ENDPOINT, minTime: Infinity, times: [], warmupTimes: [] }];
    }

    return topResults;
  } catch {
    // Ultimate fallback - should never reach here, but just in case
    return [{ url: NOZOMI_AUTO_ENDPOINT, minTime: Infinity, times: [], warmupTimes: [] }];
  }
}

/**
 * Clear all cached state (endpoints cache and failure tracking)
 * Useful for testing or when you want to force a fresh start
 */
export function clearCache(): void {
  cachedEndpoints = null;
  cacheExpiry = 0;
  failedEndpoints.clear();
}

/**
 * Get the current failure cooldown status for all endpoints
 * Useful for debugging
 */
export function getFailedEndpoints(): Map<string, number> {
  return new Map(failedEndpoints);
}

// ============================================================================
// PARALLEL REDUNDANT SUBMISSION
// ============================================================================

export interface SendResult<T> {
  /** The endpoint URL that succeeded */
  endpoint: string;
  /** The result from the successful send */
  result: T;
  /** Time taken in ms */
  duration: number;
}

export interface SendOptions {
  /** Endpoints to try (defaults to result of findFastestEndpoints) */
  endpoints?: string[] | EndpointResult[];
  /** Timeout per endpoint in ms (defaults to 10000) */
  timeout?: number;
  /** Called when an endpoint fails (for logging) */
  onError?: (endpoint: string, error: unknown) => void;
}

/**
 * Send to multiple endpoints in parallel, return first success
 *
 * NEVER THROWS - returns null if all endpoints fail
 *
 * This is the most resilient way to submit critical transactions:
 * - Sends to all endpoints simultaneously
 * - Returns as soon as ANY endpoint succeeds
 * - Tracks failures for future cooldown
 *
 * @param sendFn - Function that sends to a single endpoint URL, returns result or throws
 * @param options - Configuration options
 * @returns First successful result, or null if all failed
 *
 * @example
 * const result = await sendToFastest(async (endpointUrl) => {
 *   const connection = new Connection(`${endpointUrl}/?c=${API_KEY}`);
 *   return await connection.sendRawTransaction(txBytes, { skipPreflight: true });
 * });
 *
 * if (result) {
 *   console.log(`Success via ${result.endpoint}: ${result.result}`);
 * }
 */
export async function sendToFastest<T>(
  sendFn: (endpointUrl: string) => Promise<T>,
  options: SendOptions = {}
): Promise<SendResult<T> | null> {
  try {
    // Get endpoints
    let endpointUrls: string[];
    if (options.endpoints) {
      endpointUrls = options.endpoints.map(e =>
        typeof e === 'string' ? e : e.url
      );
    } else {
      const fastest = await findFastestEndpoints();
      endpointUrls = fastest.map(e => e.url);
    }

    if (endpointUrls.length === 0) {
      endpointUrls = [NOZOMI_AUTO_ENDPOINT];
    }

    const timeout = options.timeout || 10000;
    let hasSucceeded = false;

    // Race all endpoints
    const promises = endpointUrls.map(async (endpoint): Promise<SendResult<T> | null> => {
      const start = performance.now();

      try {
        // Skip endpoints in cooldown
        if (isEndpointInCooldown(endpoint)) {
          return null;
        }

        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Timeout')), timeout);
        });

        // Race send against timeout
        const result = await Promise.race([
          sendFn(endpoint),
          timeoutPromise
        ]);

        // Success!
        hasSucceeded = true;
        markEndpointSucceeded(endpoint);

        return {
          endpoint,
          result,
          duration: performance.now() - start
        };
      } catch (error) {
        if (!hasSucceeded) {
          markEndpointFailed(endpoint);
          try {
            options.onError?.(endpoint, error);
          } catch {
            // Ignore callback errors
          }
        }
        return null;
      }
    });

    // Wait for all to complete, return first success
    const results = await Promise.all(promises);
    return results.find(r => r !== null) || null;
  } catch {
    return null;
  }
}

/**
 * Send to endpoints sequentially with fallback
 *
 * NEVER THROWS - returns null if all endpoints fail
 *
 * Tries each endpoint in order, moving to next on failure.
 * More efficient than parallel when you expect first endpoint to usually work.
 *
 * @param sendFn - Function that sends to a single endpoint URL
 * @param options - Configuration options
 * @returns First successful result, or null if all failed
 *
 * @example
 * const result = await sendWithFallback(async (endpointUrl) => {
 *   const connection = new Connection(`${endpointUrl}/?c=${API_KEY}`);
 *   return await connection.sendRawTransaction(txBytes);
 * });
 */
export async function sendWithFallback<T>(
  sendFn: (endpointUrl: string) => Promise<T>,
  options: SendOptions = {}
): Promise<SendResult<T> | null> {
  try {
    // Get endpoints
    let endpointUrls: string[];
    if (options.endpoints) {
      endpointUrls = options.endpoints.map(e =>
        typeof e === 'string' ? e : e.url
      );
    } else {
      const fastest = await findFastestEndpoints();
      endpointUrls = fastest.map(e => e.url);
    }

    if (endpointUrls.length === 0) {
      endpointUrls = [NOZOMI_AUTO_ENDPOINT];
    }

    const timeout = options.timeout || 10000;

    // Try each endpoint in order
    for (const endpoint of endpointUrls) {
      // Skip endpoints in cooldown
      if (isEndpointInCooldown(endpoint)) {
        continue;
      }

      const start = performance.now();

      try {
        // Create timeout wrapper
        const result = await Promise.race([
          sendFn(endpoint),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), timeout)
          )
        ]);

        // Success!
        markEndpointSucceeded(endpoint);
        return {
          endpoint,
          result,
          duration: performance.now() - start
        };
      } catch (error) {
        markEndpointFailed(endpoint);
        try {
          options.onError?.(endpoint, error);
        } catch {
          // Ignore callback errors
        }
        // Continue to next endpoint
      }
    }

    return null;
  } catch {
    return null;
  }
}
