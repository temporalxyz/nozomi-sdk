#!/usr/bin/env node
/**
 * Example 1: Basic endpoint discovery
 *
 * Usage:
 *   npx tsx example/01-basic-usage.ts
 *   DEBUG=1 npx tsx example/01-basic-usage.ts
 */
import { findFastestEndpoints, NOZOMI_ENDPOINTS, EndpointResult } from '../src/index';

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log('[DEBUG]', new Date().toISOString(), ...args);
};

async function main() {
  debug('Starting basicUsage - finding top 3 fastest endpoints');
  debug('Testing against', NOZOMI_ENDPOINTS.length, 'endpoints (2 warmup + 5 pings each)');
  const startTime = performance.now();

  const allResults: EndpointResult[] = [];

  const fastest = await findFastestEndpoints({
    onResult: (result) => {
      allResults.push(result);
      const warmupStr = result.warmupTimes?.map((t) => t.toFixed(1)).join(', ') || 'N/A';
      const timesStr = result.times?.map((t) => t.toFixed(1)).join(', ') || 'N/A';
      debug(`  ${result.url}: min=${result.minTime.toFixed(1)}ms | warmup=[${warmupStr}] | pings=[${timesStr}]`);
    }
  });

  debug('Endpoint discovery took', (performance.now() - startTime).toFixed(2), 'ms');

  if (DEBUG) {
    debug('--- All endpoints sorted by latency ---');
    allResults
      .filter((r) => r.minTime !== Infinity)
      .sort((a, b) => a.minTime - b.minTime)
      .forEach((r, i) => {
        const timesStr = r.times?.map((t) => t.toFixed(1)).join(', ') || 'N/A';
        debug(`  ${i + 1}. ${r.url}: ${r.minTime.toFixed(1)}ms [${timesStr}]`);
      });
    const failed = allResults.filter((r) => r.minTime === Infinity);
    if (failed.length > 0) {
      debug(`  (${failed.length} endpoints failed/timed out)`);
    }
    debug('---------------------------------------');
  }

  console.log(
    'Top fastest endpoints:',
    fastest.map((r) => ({ url: r.url, region: r.region, minTime: `${r.minTime.toFixed(1)}ms` }))
  );
}

main().catch(console.error);
