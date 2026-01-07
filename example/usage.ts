/**
 * Nozomi SDK Usage Examples
 *
 * Prerequisites for transaction examples (6 & 7):
 *   npm install @solana/web3.js
 *
 * Environment variables:
 *   DEBUG               - Set to "1" or "true" to enable debug logging
 *   NOZOMI_API_KEY      - Your Nozomi API key
 *   SOLANA_PRIVATE_KEY  - JSON array of your wallet's secret key bytes
 */
import { findFastestEndpoints, NozomiClient, NOZOMI_ENDPOINTS, EndpointResult } from '@temporalxyz/nozomi-sdk';
// For local development: import { findFastestEndpoints, NozomiClient, NOZOMI_ENDPOINTS, EndpointResult } from '../src/index';

// Debug logging utility
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const debug = (...args: unknown[]) => {
  if (DEBUG) {
    console.log('[DEBUG]', new Date().toISOString(), ...args);
  }
};

// Example 1: Find the 3 fastest endpoints (default)
async function basicUsage() {
  debug('Starting basicUsage - finding top 3 fastest endpoints');
  debug('Testing against', NOZOMI_ENDPOINTS.length, 'endpoints (2 warmup + 5 pings each)');
  const startTime = performance.now();

  // Collect all results for final summary
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

  // Show sorted summary of all endpoints
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
    'Top 3 fastest endpoints:',
    fastest.map((r) => ({ url: r.url, minTime: r.minTime }))
  );
}

// Example 2: Find the single fastest endpoint
async function findSingleFastest() {
  const [fastest] = await findFastestEndpoints({ topCount: 1 });
  console.log('Fastest endpoint:', fastest.url, `(${fastest.minTime.toFixed(2)}ms)`);
}

// Example 3: Test only direct endpoints (no Cloudflare)
async function testDirectOnly() {
  const directEndpoints = NOZOMI_ENDPOINTS.filter(ep => ep.type === 'direct');
  const fastest = await findFastestEndpoints({
    endpoints: directEndpoints,
    topCount: 3
  });
  console.log('Fastest direct endpoints:', fastest);
}

// Example 4: Test only Cloudflare endpoints
async function testCfOnly() {
  const cfEndpoints = NOZOMI_ENDPOINTS.filter(ep => ep.type === 'cloudflare');

  const fastest = await findFastestEndpoints({
    endpoints: cfEndpoints,
    topCount: 3
  });
  console.log('Fastest CF endpoints:', fastest);
}

// Example 5: Custom ping configuration
async function customConfig() {
  const fastest = await findFastestEndpoints({
    pingCount: 10,    // 10 measurement pings (after warmup) - more than default 5
    topCount: 5,      // Return top 5
    timeout: 3000     // 3 second timeout
  });
  console.log('Results with custom config:', fastest);
}

// Example 6: Actually send a transaction via Nozomi
async function sendTransaction() {
  debug('Starting sendTransaction');
  debug('Importing @solana/web3.js...');
  const {
    Connection,
    Keypair,
    SystemProgram,
    Transaction,
    LAMPORTS_PER_SOL,
    PublicKey
  } = await import('@solana/web3.js');
  debug('@solana/web3.js imported successfully');

  // Find the fastest Nozomi endpoint
  debug('Finding fastest Nozomi endpoint...');
  const discoverStart = performance.now();
  const allResults: EndpointResult[] = [];
  const [fastest] = await findFastestEndpoints({
    topCount: 1,
    onResult: (result) => {
      allResults.push(result);
      const warmupStr = result.warmupTimes?.map((t) => t.toFixed(1)).join(', ') || 'N/A';
      const timesStr = result.times?.map((t) => t.toFixed(1)).join(', ') || 'N/A';
      debug(`  ${result.url}: min=${result.minTime.toFixed(1)}ms | warmup=[${warmupStr}] | pings=[${timesStr}]`);
    }
  });
  debug('Endpoint discovery took', (performance.now() - discoverStart).toFixed(2), 'ms');

  // Show sorted summary of all endpoints
  if (DEBUG) {
    debug('--- All endpoints sorted by latency ---');
    allResults
      .filter((r) => r.minTime !== Infinity)
      .sort((a, b) => a.minTime - b.minTime)
      .forEach((r, i) => {
        const timesStr = r.times?.map((t) => t.toFixed(1)).join(', ') || 'N/A';
        debug(`  ${i + 1}. ${r.url}: ${r.minTime.toFixed(1)}ms [${timesStr}]`);
      });
    debug('---------------------------------------');
  }

  console.log(`Using fastest endpoint: ${fastest.url} (${fastest.minTime.toFixed(2)}ms)`);

  // Create connection to the fastest Nozomi endpoint with your API key
  const API_KEY = process.env.NOZOMI_API_KEY || 'YOUR_API_KEY';
  const nozomiUrl = `${fastest.url}/?c=${API_KEY}`;
  debug('Creating Nozomi connection to:', fastest.url);
  const nozomiConnection = new Connection(nozomiUrl, 'confirmed');

  // Also need a standard RPC for fetching blockhash and account info
  const rpcUrl = 'https://api.mainnet-beta.solana.com';
  debug('Creating standard RPC connection to:', rpcUrl);
  const rpcConnection = new Connection(rpcUrl, 'confirmed');

  // Load your keypair (from file or environment)
  // In production, use a secure key management solution
  debug('Loading keypair from SOLANA_PRIVATE_KEY env var');
  const secretKey = Uint8Array.from(JSON.parse(process.env.SOLANA_PRIVATE_KEY || '[]'));
  const payer = Keypair.fromSecretKey(secretKey);
  debug('Payer public key:', payer.publicKey.toBase58());

  // Build a simple transfer transaction
  const recipient = new PublicKey('11111111111111111111111111111111'); // Replace with actual recipient
  const lamports = 0.001 * LAMPORTS_PER_SOL;
  debug('Building transaction:', { recipient: recipient.toBase58(), lamports });

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports
    })
  );

  // Get recent blockhash from standard RPC
  debug('Fetching recent blockhash...');
  const blockhashStart = performance.now();
  const { blockhash, lastValidBlockHeight } = await rpcConnection.getLatestBlockhash();
  debug('Blockhash fetched in', (performance.now() - blockhashStart).toFixed(2), 'ms');
  debug('Blockhash:', blockhash, 'lastValidBlockHeight:', lastValidBlockHeight);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = payer.publicKey;

  // Sign the transaction
  debug('Signing transaction...');
  transaction.sign(payer);
  const serializedTx = transaction.serialize();
  debug('Transaction signed, size:', serializedTx.length, 'bytes');

  // Send via Nozomi for fastest submission
  debug('Sending transaction via Nozomi...');
  const sendStart = performance.now();
  const signature = await nozomiConnection.sendRawTransaction(serializedTx, {
    skipPreflight: true, // Nozomi handles this
    maxRetries: 0        // Let Nozomi handle retries
  });
  debug('Transaction sent in', (performance.now() - sendStart).toFixed(2), 'ms');

  console.log(`Transaction sent! Signature: ${signature}`);
  console.log(`View on Solscan: https://solscan.io/tx/${signature}`);

  // Confirm the transaction
  debug('Waiting for confirmation...');
  const confirmStart = performance.now();
  const confirmation = await rpcConnection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight
  });
  debug('Confirmation received in', (performance.now() - confirmStart).toFixed(2), 'ms');

  if (confirmation.value.err) {
    debug('Transaction error:', confirmation.value.err);
    console.error('Transaction failed:', confirmation.value.err);
  } else {
    debug('Transaction confirmed successfully');
    console.log('Transaction confirmed!');
  }

  return signature;
}

// Example 7: Send transaction with fallback endpoints
async function sendWithFallback(signedTxBytes: Uint8Array) {
  debug('Starting sendWithFallback');
  debug('Transaction size:', signedTxBytes.length, 'bytes');
  const { Connection } = await import('@solana/web3.js');

  // Get top 3 fastest endpoints for fallback
  debug('Finding top 3 fastest endpoints for fallback...');
  const discoverStart = performance.now();
  const allResults: EndpointResult[] = [];
  const fastestEndpoints: EndpointResult[] = await findFastestEndpoints({
    topCount: 3,
    onResult: (result) => {
      allResults.push(result);
      const warmupStr = result.warmupTimes?.map((t) => t.toFixed(1)).join(', ') || 'N/A';
      const timesStr = result.times?.map((t) => t.toFixed(1)).join(', ') || 'N/A';
      debug(`  ${result.url}: min=${result.minTime.toFixed(1)}ms | warmup=[${warmupStr}] | pings=[${timesStr}]`);
    }
  });
  debug('Endpoint discovery took', (performance.now() - discoverStart).toFixed(2), 'ms');

  // Show sorted summary of all endpoints
  if (DEBUG) {
    debug('--- All endpoints sorted by latency ---');
    allResults
      .filter((r) => r.minTime !== Infinity)
      .sort((a, b) => a.minTime - b.minTime)
      .forEach((r, i) => {
        const timesStr = r.times?.map((t) => t.toFixed(1)).join(', ') || 'N/A';
        debug(`  ${i + 1}. ${r.url}: ${r.minTime.toFixed(1)}ms [${timesStr}]`);
      });
    debug('---------------------------------------');
  }

  console.log('Fallback endpoints:', fastestEndpoints.map((e) => e.url));

  const API_KEY = process.env.NOZOMI_API_KEY || 'YOUR_API_KEY';

  // Try each endpoint until one succeeds
  for (let i = 0; i < fastestEndpoints.length; i++) {
    const endpoint = fastestEndpoints[i];
    debug(`Attempt ${i + 1}/${fastestEndpoints.length}: trying ${endpoint.url}`);
    try {
      const connection = new Connection(`${endpoint.url}/?c=${API_KEY}`, 'confirmed');
      const sendStart = performance.now();
      const signature = await connection.sendRawTransaction(signedTxBytes, {
        skipPreflight: true
      });
      debug(`Success! Sent in ${(performance.now() - sendStart).toFixed(2)}ms`);
      console.log(`Success via ${endpoint.url}: ${signature}`);
      return signature;
    } catch (err) {
      debug(`Failed on ${endpoint.url}:`, err instanceof Error ? err.message : err);
      console.warn(`Failed on ${endpoint.url}, trying next...`);
    }
  }

  debug('All endpoints failed');
  throw new Error('All endpoints failed');
}

// Example 8: Using NozomiClient (recommended)
async function usingNozomiClient() {
  const API_KEY = process.env.NOZOMI_API_KEY || 'YOUR_API_KEY';

  // Initialize client with your API key and default options
  const client = new NozomiClient(API_KEY, {
    topCount: 3,
    timeout: 3000
  });

  // Find fastest endpoints
  const endpoints = await client.findFastestEndpoints();
  console.log('Fastest endpoints:', endpoints.map(e => e.url));

  // Get RPC URL with API key included
  const rpcUrl = client.getEndpointUrl(endpoints[0]);
  console.log('RPC URL:', rpcUrl);

  // Or get the fastest endpoint URL directly
  const fastestUrl = await client.getFastestEndpointUrl();
  console.log('Fastest RPC URL:', fastestUrl);
}

// Example 9: NozomiClient with Solana
async function nozomiClientWithSolana() {
  const { Connection, PublicKey } = await import('@solana/web3.js');

  const client = new NozomiClient(process.env.NOZOMI_API_KEY || 'YOUR_API_KEY');

  // Get cached endpoints (fetches once, reuses after)
  const endpoints = await client.getEndpoints();

  // Create connection with the fastest endpoint
  const connection = new Connection(client.getEndpointUrl(endpoints[0]), 'confirmed');

  // Use the connection
  const balance = await connection.getBalance(new PublicKey('11111111111111111111111111111111'));
  console.log('Balance:', balance);

  // Refresh endpoints periodically if needed
  await client.refresh();
}

// Run examples
basicUsage();
