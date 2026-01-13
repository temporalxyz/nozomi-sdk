#!/usr/bin/env node
/**
 * Example 2: Find single fastest endpoint
 *
 * Usage:
 *   npx tsx example/02-find-single-fastest.ts
 */
import { findFastestEndpoints } from '../src/index';

async function main() {
  const [fastest] = await findFastestEndpoints({ topCount: 1 });
  console.log('Fastest endpoint:', fastest.url, `(${fastest.minTime.toFixed(2)}ms)`);
}

main().catch(console.error);
