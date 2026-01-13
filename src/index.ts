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

type SolanaTransaction = {
  serialize(): Uint8Array;
  signatures?: Uint8Array[];
  signature?: Uint8Array | null;
};

async function getTransactionSignature(transaction: SolanaTransaction): Promise<string> {
  // Try to import bs58 from @solana/web3.js's dependencies
  try {
    // @solana/web3.js uses bs58 internally, try to import it
    const bs58Module = await import('bs58');
    const bs58 = bs58Module.default || bs58Module;

    // For VersionedTransaction or Transaction with signatures array
    if (transaction.signatures && transaction.signatures.length > 0) {
      return bs58.encode(transaction.signatures[0]);
    }

    // For legacy Transaction with signature property
    if (transaction.signature) {
      return bs58.encode(transaction.signature);
    }

    // Fallback: parse from serialized transaction
    const serialized = transaction.serialize();
    const signatureBytes = serialized.slice(1, 65);
    return bs58.encode(signatureBytes);
  } catch {
    // Fallback to manual base58 encoding if bs58 module not available
    return extractSignatureManually(transaction.serialize());
  }
}

// Fallback base58 encoding (only used if @solana/web3.js not available)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = '';
  for (const byte of bytes) {
    if (byte === 0) result += BASE58_ALPHABET[0];
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]];
  }
  return result;
}

function extractSignatureManually(serializedTx: Uint8Array): string {
  if (serializedTx[0] === 0 || serializedTx.length < 65) {
    throw new Error('Invalid transaction: no signatures found');
  }
  const signatureBytes = serializedTx.slice(1, 65);
  return base58Encode(signatureBytes);
}

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
  /** Default number of top endpoints to return (1-10, default: 4) */
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
  /** Keep-warm interval in ms (default: 30000). Set to 0 to disable. */
  keepWarmInterval?: number;
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
  private keepWarmTimer: ReturnType<typeof setInterval> | null = null;
  private readonly keepWarmInterval: number;

  /**
   * Create a new NozomiClient.
   *
   * @param clientId - Your Nozomi API key
   * @param options - Default options for endpoint discovery
   */
  constructor(clientId: string, options: NozomiClientOptions = {}) {
    this.clientId = clientId;
    this.defaultOptions = options;
    this.keepWarmInterval = options.keepWarmInterval ?? 30000;
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
   * Automatically starts keep-warm in the background on first call.
   */
  async getEndpoints(options: FindFastestOptions = {}): Promise<EndpointResult[]> {
    if (!this.cachedEndpoints) {
      this.cachedEndpoints = await this.findFastestEndpoints(options);
      if (!this.keepWarmTimer && this.keepWarmInterval > 0) {
        this.startKeepWarm();
      }
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

  /**
   * Start the keep-warm interval.
   * Sends periodic ping requests to all cached endpoints to maintain warm connections.
   * Uses HTTP keep-alive for connection reuse.
   */
  startKeepWarm(): void {
    if (this.keepWarmTimer || this.keepWarmInterval <= 0) return;

    this.keepWarmTimer = setInterval(() => {
      this.warmConnections();
    }, this.keepWarmInterval);

    // Unref the timer so it doesn't prevent Node.js from exiting
    if (typeof this.keepWarmTimer === 'object' && 'unref' in this.keepWarmTimer) {
      this.keepWarmTimer.unref();
    }
  }

  /**
   * Stop the keep-warm interval.
   */
  stopKeepWarm(): void {
    if (this.keepWarmTimer) {
      clearInterval(this.keepWarmTimer);
      this.keepWarmTimer = null;
    }
  }

  /**
   * Check if keep-warm is currently active.
   */
  isKeepWarmActive(): boolean {
    return this.keepWarmTimer !== null;
  }

  /**
   * Manually warm all cached endpoint connections.
   * Sends a ping request to each endpoint with HTTP keep-alive enabled.
   */
  async warmConnections(): Promise<void> {
    if (!this.cachedEndpoints || this.cachedEndpoints.length === 0) return;

    const endpoint = this.defaultOptions.endpoint ?? '/ping';
    const timeout = this.defaultOptions.timeout ?? 5000;

    await Promise.all(
      this.cachedEndpoints.map(async (ep) => {
        const pingUrl = ep.url.replace(/\/+$/, '') + endpoint;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          await fetch(pingUrl, {
            method: 'GET',
            signal: controller.signal,
            cache: 'no-store',
            keepalive: true,
          });
        } catch {
          // Ignore errors - connection warming is best-effort
        } finally {
          clearTimeout(timeoutId);
        }
      })
    );
  }

  /**
   * Clean up resources. Call this when done with the client.
   */
  destroy(): void {
    this.stopKeepWarm();
    this.clearCache();
  }

  /**
   * Send a signed transaction to Nozomi using the fast /api/sendTransaction2 endpoint.
   * Uses base64 encoding and text/plain content type for optimal performance.
   *
   * Sends to all cached endpoints in parallel for redundancy.
   *
   * @param transaction - Signed transaction (Transaction or VersionedTransaction with serialize() method)
   * @param options - Send options
   * @returns Promise with transaction signature (base58)
   * @throws Error if all endpoints fail
   */
  async sendTransactionV2(
    transaction: SolanaTransaction,
    options: SendTransactionOptions = {}
  ): Promise<string> {
    // Serialize and encode to base64 immediately
    const serializedTx = transaction.serialize();
    const txBase64 = typeof Buffer !== 'undefined'
      ? Buffer.from(serializedTx).toString('base64')
      : btoa(String.fromCharCode(...serializedTx));

    const endpoints = this.cachedEndpoints ?? await this.getEndpoints();
    const timeout = options.timeout ?? this.defaultOptions.timeout ?? 5000;
    const maxRetries = options.maxRetries ?? 2;

    const sendToEndpoint = async (endpoint: EndpointResult, attempt: number = 0): Promise<{ endpoint: string; success: boolean; error?: string }> => {
      const url = `${endpoint.url.replace(/\/+$/, '')}/api/sendTransaction2?c=${this.clientId}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: txBase64,
          signal: controller.signal,
          keepalive: true,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          return { endpoint: endpoint.url, success: true };
        }

        const errorText = await response.text().catch(() => '');
        const error = `HTTP ${response.status}: ${errorText}`;
        if (attempt < maxRetries) {
          return sendToEndpoint(endpoint, attempt + 1);
        }
        return { endpoint: endpoint.url, success: false, error };
      } catch (err) {
        clearTimeout(timeoutId);
        const error = err instanceof Error ? err.message : 'Unknown error';
        if (attempt < maxRetries) {
          return sendToEndpoint(endpoint, attempt + 1);
        }
        return { endpoint: endpoint.url, success: false, error };
      }
    };

    // Send to all endpoints in parallel for maximum speed
    const results = await Promise.all(endpoints.map(ep => sendToEndpoint(ep)));
    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);

    // Log any failures for debugging
    for (const failure of failures) {
      console.warn(`[nozomi-sdk] Failed to send to ${failure.endpoint}: ${failure.error}`);
    }

    if (successes.length === 0) {
      const errors = failures.map(f => `${f.endpoint}: ${f.error}`).join('; ');
      throw new Error(`All endpoints failed: ${errors}`);
    }

    // Extract signature after successful send
    return getTransactionSignature(transaction);
  }
}

export interface SendTransactionOptions {
  /** Timeout per request in ms (default: 5000) */
  timeout?: number;
  /** Max retries per endpoint (default: 2) */
  maxRetries?: number;
}

/**
 * Find the fastest Nozomi endpoints.
 *
 * NEVER THROWS - always returns at least the auto-routed endpoint.
 *
 * By default returns [4 fastest endpoints, auto-routed endpoint].
 */
export async function findFastestEndpoints(options: FindFastestOptions = {}): Promise<EndpointResult[]> {
  try {
    // Get endpoint configs
    let configs = options.endpoints || await getEndpointConfigs(options.endpointsUrl);
    if (!Array.isArray(configs) || configs.length === 0) configs = [...NOZOMI_ENDPOINTS];

    // Config with defaults
    const pingCount = Math.max(1, Math.min(20, options.pingCount ?? 5));
    const topCount = Math.max(1, Math.min(10, options.topCount ?? 4));
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

    // Filter and sort by latency
    const validResults = results
      .filter(r => r.minTime !== Infinity && isFinite(r.minTime))
      .sort((a, b) => a.minTime - b.minTime);

    let topResults: EndpointResult[];

    if (includeAutoRouted) {
      const nonAutoResults = validResults.filter(r => r.region !== 'auto');
      topResults = nonAutoResults.slice(0, topCount);

      const autoResult = validResults.find(r => r.region === 'auto');
      topResults.push(autoResult ?? { url: NOZOMI_AUTO_ENDPOINT, region: 'auto', minTime: Infinity, times: [], warmupTimes: [] });
    } else {
      topResults = validResults.slice(0, topCount);
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
