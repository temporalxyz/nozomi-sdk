#!/usr/bin/env node
/**
 * Example 3: Using NozomiClient (recommended)
 *
 * Usage:
 *   npx tsx example/03-using-nozomi-client.ts --api-key YOUR_API_KEY
 *   NOZOMI_API_KEY=xxx npx tsx example/03-using-nozomi-client.ts
 */
import { NozomiClient } from '../src/index';

function parseArgs() {
  const args = process.argv.slice(2);
  let apiKey = process.env.NOZOMI_API_KEY;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-key' && args[i + 1]) {
      apiKey = args[i + 1];
      i++;
    }
  }

  if (!apiKey) {
    console.error('Error: API key required');
    console.error('Usage: npx tsx example/03-using-nozomi-client.ts --api-key YOUR_API_KEY');
    console.error('   or: NOZOMI_API_KEY=xxx npx tsx example/03-using-nozomi-client.ts');
    process.exit(1);
  }

  return { apiKey };
}

async function main() {
  const { apiKey } = parseArgs();

  const client = new NozomiClient(apiKey, {
    topCount: 3,
    timeout: 3000
  });

  console.log('Finding fastest endpoints...');
  const endpoints = await client.findFastestEndpoints();
  console.log('Fastest endpoints:', endpoints.map(e => e.url));

  console.log('\nGetting RPC URL with API key included...');
  const rpcUrl = client.getEndpointUrl(endpoints[0]);
  console.log('RPC URL:', rpcUrl);

  console.log('\nGetting fastest endpoint URL directly...');
  const fastestUrl = await client.getFastestEndpointUrl();
  console.log('Fastest RPC URL:', fastestUrl);

  client.destroy();
}

main().catch(console.error);
