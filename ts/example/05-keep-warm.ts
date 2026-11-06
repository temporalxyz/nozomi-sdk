#!/usr/bin/env node
/**
 * Example 5: Connection keep-warm demonstration
 *
 * Usage:
 *   npx tsx example/05-keep-warm.ts --api-key YOUR_API_KEY
 *   NOZOMI_API_KEY=xxx npx tsx example/05-keep-warm.ts
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
    console.error('Usage: npx tsx example/05-keep-warm.ts --api-key YOUR_API_KEY');
    console.error('   or: NOZOMI_API_KEY=xxx npx tsx example/05-keep-warm.ts');
    process.exit(1);
  }

  return { apiKey };
}

async function main() {
  const { apiKey } = parseArgs();

  const client = new NozomiClient(apiKey, {
    keepWarmInterval: 10000, // 10 seconds for demo (default is 30s)
  });

  console.log('Getting endpoints (this starts keep-warm automatically)...');
  const endpoints = await client.getEndpoints();
  console.log('Cached endpoints:', endpoints.map(e => e.url));

  console.log('\nKeep-warm active:', client.isKeepWarmActive());
  console.log('Keep-warm will ping all endpoints every 10 seconds');
  console.log('Waiting 30 seconds to demonstrate...\n');

  // Wait and show keep-warm in action
  await new Promise(resolve => setTimeout(resolve, 30000));

  console.log('\nManually warming connections now...');
  await client.warmConnections();
  console.log('Manual warm complete');

  console.log('\nCleaning up (stops keep-warm)...');
  client.destroy();
  console.log('Keep-warm active:', client.isKeepWarmActive());
  console.log('Done!');
}

main().catch(console.error);
