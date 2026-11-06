# Nozomi SDK

Find the fastest Nozomi endpoints for optimal Solana transaction submission.

## Installation

```bash
npm install @temporalxyz/nozomi-sdk
```

## Usage

See [example/README.md](example/README.md) for runnable CLI examples.

### Basic Usage

```typescript
import { findFastestEndpoints } from '@temporalxyz/nozomi-sdk';

// Find the 4 fastest endpoints + auto-routed fallback
const endpoints = await findFastestEndpoints();

console.log(endpoints);
// [
//   { url: 'https://pit1.nozomi.temporal.xyz', region: 'pittsburgh', minTime: 12.5, ... },
//   { url: 'https://ewr1.nozomi.temporal.xyz', region: 'newark', minTime: 15.2, ... },
//   { url: 'https://nozomi.temporal.xyz', region: 'auto', minTime: 18.0, ... }
// ]
```

### Using NozomiClient (Recommended)

```typescript
import { NozomiClient } from '@temporalxyz/nozomi-sdk';

const client = new NozomiClient('YOUR_API_KEY', {
  topCount: 3,
  timeout: 3000
});

// Find fastest endpoints
const endpoints = await client.findFastestEndpoints();

// Get RPC URL with API key included
const rpcUrl = client.getEndpointUrl(endpoints[0]);
// => "https://pit1.nozomi.temporal.xyz/?c=YOUR_API_KEY"

// Or get the fastest endpoint URL directly
const fastestUrl = await client.getFastestEndpointUrl();
```

### Send Transaction (Fast API v2)

```typescript
import { NozomiClient } from '@temporalxyz/nozomi-sdk';
import { VersionedTransaction } from '@solana/web3.js';

const client = new NozomiClient('YOUR_API_KEY');

// Build and sign your transaction...
const signedTx: VersionedTransaction = /* your signed transaction */;

// Send to all fastest endpoints in parallel
const signature = await client.sendTransactionV2(signedTx);

console.log(`Signature: ${signature}`);
```

### Keep Connections Warm

Keep-warm runs automatically in the background after the first `getEndpoints()` call.

```typescript
const client = new NozomiClient('YOUR_API_KEY', {
  keepWarmInterval: 30000,  // Ping every 30s (default), set to 0 to disable
});

// Starts keep-warm automatically
await client.getEndpoints();

// Clean up when done (stops keep-warm)
client.destroy();
```

### Find Single Fastest

```typescript
const [fastest] = await findFastestEndpoints({ topCount: 1 });
console.log(`Fastest: ${fastest.url} (${fastest.minTime.toFixed(2)}ms)`);
```

### With Solana Web3.js

```typescript
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { findFastestEndpoints } from '@temporalxyz/nozomi-sdk';

const [fastest] = await findFastestEndpoints({ topCount: 1 });

const API_KEY = process.env.NOZOMI_API_KEY;
const connection = new Connection(`${fastest.url}/?c=${API_KEY}`, 'confirmed');

// Send transaction via Nozomi
const signature = await connection.sendRawTransaction(signedTx, {
  skipPreflight: true,
  maxRetries: 0
});
```

### Configuration Options

```typescript
const results = await findFastestEndpoints({
  // Number of measurement pings per endpoint (default: 5, max: 20)
  pingCount: 10,

  // Number of warmup pings before measurement (default: 2, max: 5)
  warmupCount: 2,

  // Number of top endpoints to return (default: 2, max: 10)
  topCount: 3,

  // Timeout per ping in ms (default: 5000, min: 1000, max: 30000)
  timeout: 3000,

  // Include auto-routed endpoint in results (default: true)
  includeAutoRouted: true,

  // Custom ping endpoint path (default: '/ping')
  endpoint: '/ping',

  // Custom endpoints URL (default: GitHub raw URL)
  endpointsUrl: 'https://example.com/endpoints.json',

  // Custom endpoint configs (skips remote fetch)
  endpoints: [
    { url: 'https://custom.xyz', region: 'custom', type: 'direct' }
  ],

  // Callback for each endpoint result (useful for progress)
  onResult: (result) => {
    console.log(`${result.url}: ${result.minTime}ms`);
  }
});
```

### Fallback Strategy

```typescript
const endpoints = await findFastestEndpoints({ topCount: 3 });

for (const endpoint of endpoints) {
  try {
    const connection = new Connection(`${endpoint.url}/?c=${API_KEY}`);
    const sig = await connection.sendRawTransaction(tx);
    console.log(`Success via ${endpoint.url}`);
    break;
  } catch (err) {
    console.warn(`Failed on ${endpoint.url}, trying next...`);
  }
}
```

## API Reference

### `NozomiClient`

```typescript
const client = new NozomiClient(clientId: string, options?: NozomiClientOptions);
```

| Method | Returns | Description |
|--------|---------|-------------|
| `findFastestEndpoints(options?)` | `Promise<EndpointResult[]>` | Find fastest endpoints |
| `getEndpointUrl(endpoint)` | `string` | Get RPC URL with API key |
| `getFastestEndpointUrl(options?)` | `Promise<string>` | Get fastest RPC URL directly |
| `getEndpoints(options?)` | `Promise<EndpointResult[]>` | Get cached endpoints |
| `refresh(options?)` | `Promise<EndpointResult[]>` | Refresh cached endpoints |
| `clearCache()` | `void` | Clear endpoint cache |
| `sendTransactionV2(tx, options?)` | `Promise<string>` | Send signed transaction, returns signature |
| `startKeepWarm()` | `void` | Start periodic connection warming |
| `stopKeepWarm()` | `void` | Stop connection warming |
| `warmConnections()` | `Promise<void>` | Manually warm all connections |
| `destroy()` | `void` | Clean up resources |

### `findFastestEndpoints(options?)`

Returns a promise that resolves to an array of `EndpointResult` objects.

**Never throws** - always returns at least one endpoint (the auto-routed fallback).

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pingCount` | number | 5 | Number of measurement pings (1-20) |
| `warmupCount` | number | 2 | Number of warmup pings (0-5) |
| `topCount` | number | 4 | Number of top results to return (1-10) |
| `timeout` | number | 5000 | Timeout per ping in ms (1000-30000) |
| `includeAutoRouted` | boolean | true | Include auto-routed endpoint |
| `endpoint` | string | '/ping' | Ping endpoint path |
| `endpointsUrl` | string | GitHub URL | URL to fetch endpoint configs |
| `endpoints` | EndpointConfig[] | - | Custom endpoint configs |
| `onResult` | function | - | Callback for each result |

#### Result Type

```typescript
interface EndpointResult {
  url: string;           // Endpoint URL
  region: string;        // Region identifier
  minTime: number;       // Minimum ping time (ms)
  times?: number[];      // All measurement times
  warmupTimes?: number[]; // Warmup times
}
```

### Exports

```typescript
import {
  NozomiClient,            // Client class (recommended)
  findFastestEndpoints,    // Standalone function
  NOZOMI_ENDPOINTS,        // Hardcoded fallback endpoints
  NOZOMI_AUTO_ENDPOINT,    // Auto-routed endpoint URL
  NOZOMI_EDGE_ENDPOINT,    // Edge endpoint URL (geo-DNS)
  NOZOMI_ENDPOINTS_URL,    // Default endpoints JSON URL
  // Types
  NozomiClientOptions,
  SendTransactionOptions,
  EndpointResult,
  EndpointConfig,
  FindFastestOptions
} from '@temporalxyz/nozomi-sdk';
```

## Features

- **Zero dependencies** - works in Node.js and browsers
- **Never throws** - always returns valid results with fallbacks
- **Fast API v2** - send transactions via optimized `/api/sendTransaction2` endpoint
- **Multi-endpoint send** - send to all fastest endpoints in parallel for redundancy
- **Connection keep-warm** - periodic pings to maintain warm HTTP connections
- **Sorted by latency** - returns endpoints ordered by response time
- **Warmup pings** - accounts for TLS/TCP connection setup
- **Remote config** - fetches latest endpoints from GitHub with fallback
- **Fully typed** - complete TypeScript definitions

## License

MIT
