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
 * - No global mutable state - safe for concurrent calls
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
 * Get endpoints - tries remote, falls back to hardcoded
 *
 * NEVER THROWS - always returns valid endpoints
 * No caching - fresh fetch every time
 *
 * @param endpointsUrl - URL to fetch endpoints from (defaults to GitHub raw URL)
 */
export async function getEndpoints(endpointsUrl?: string): Promise<string[]> {
  try {
    const url = endpointsUrl || NOZOMI_ENDPOINTS_URL;

    // Try remote fetch
    const remote = await fetchEndpoints(url);
    if (remote && remote.length > 0) {
      return remote;
    }
  } catch {
    // Fall through to hardcoded
  }

  // Fallback to hardcoded endpoints
  return [...NOZOMI_ENDPOINTS];
}

export interface EndpointResult {
  url: string;
  minTime: number;
  /** All ping times for this endpoint (excluding warmup) */
  times?: number[];
  /** Warmup request times (for debugging connection setup) */
  warmupTimes?: number[];
}

export interface FindFastestOptions {
  /** Custom endpoint URLs to test (defaults to fetching from remote/hardcoded) */
  urls?: string[];
  /** URL to fetch endpoints from if urls not provided */
  endpointsUrl?: string;
  /** Number of pings per endpoint (defaults to 5) */
  pingCount?: number;
  /** Number of fastest endpoints to return (defaults to 2, plus auto-routed) */
  topCount?: number;
  /** Timeout per ping request in ms (defaults to 5000) */
  timeout?: number;
  /** Ping endpoint path (defaults to '/ping') */
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
 * No global state - safe for concurrent calls.
 *
 * By default returns [2 fastest regional endpoints, auto-routed endpoint].
 * The auto-routed endpoint is always included as a fallback unless disabled.
 *
 * @param options - Configuration options
 * @param options.urls - Custom endpoint URLs (defaults to fetching from remote/hardcoded)
 * @param options.endpointsUrl - URL to fetch endpoints from if urls not provided
 * @param options.pingCount - Number of pings per endpoint (defaults to 5)
 * @param options.topCount - Number of fastest endpoints to return (defaults to 2, plus auto-routed)
 * @param options.timeout - Timeout per ping request in ms (defaults to 5000)
 * @param options.endpoint - Ping endpoint path (defaults to '/ping')
 * @param options.warmupCount - Number of warmup requests before measuring (defaults to 2)
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
      urls = options.urls || await getEndpoints(options.endpointsUrl);
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
  /** URL to fetch endpoints from if endpoints not provided */
  endpointsUrl?: string;
  /** Timeout per endpoint in ms (defaults to 10000) */
  timeout?: number;
  /** Called when an endpoint fails (for logging) */
  onError?: (endpoint: string, error: unknown) => void;
}

/**
 * Send to multiple endpoints in parallel, return first success
 *
 * NEVER THROWS - returns null if all endpoints fail
 * No global state - safe for concurrent calls.
 *
 * This is the most resilient way to submit critical transactions:
 * - Sends to all endpoints simultaneously
 * - Returns as soon as ANY endpoint succeeds
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
      const fastest = await findFastestEndpoints({ endpointsUrl: options.endpointsUrl });
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

        return {
          endpoint,
          result,
          duration: performance.now() - start
        };
      } catch (error) {
        if (!hasSucceeded) {
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
 * No global state - safe for concurrent calls.
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
      const fastest = await findFastestEndpoints({ endpointsUrl: options.endpointsUrl });
      endpointUrls = fastest.map(e => e.url);
    }

    if (endpointUrls.length === 0) {
      endpointUrls = [NOZOMI_AUTO_ENDPOINT];
    }

    const timeout = options.timeout || 10000;

    // Try each endpoint in order
    for (const endpoint of endpointUrls) {
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
        return {
          endpoint,
          result,
          duration: performance.now() - start
        };
      } catch (error) {
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
