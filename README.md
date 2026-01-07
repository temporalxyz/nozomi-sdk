# Nozomi SDK

Find the fastest Nozomi endpoints for optimal Solana transaction submission.

## Installation

```bash
npm install nozomi-sdk
```

## Usage

### Basic Usage

```typescript
import { findFastestEndpoints } from 'nozomi-sdk';

// Find the 2 fastest regional endpoints + auto-routed fallback
const endpoints = await findFastestEndpoints();

console.log(endpoints);
// [
//   { url: 'https://pit1.nozomi.temporal.xyz', region: 'pittsburgh', minTime: 12.5, ... },
//   { url: 'https://ewr1.nozomi.temporal.xyz', region: 'newark', minTime: 15.2, ... },
//   { url: 'https://nozomi.temporal.xyz', region: 'auto', minTime: 18.0, ... }
// ]
```

### Find Single Fastest

```typescript
const [fastest] = await findFastestEndpoints({ topCount: 1 });
console.log(`Fastest: ${fastest.url} (${fastest.minTime.toFixed(2)}ms)`);
```

### With Solana Web3.js

```typescript
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { findFastestEndpoints } from 'nozomi-sdk';

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

### `findFastestEndpoints(options?)`

Returns a promise that resolves to an array of `EndpointResult` objects.

**Never throws** - always returns at least one endpoint (the auto-routed fallback).

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pingCount` | number | 5 | Number of measurement pings (1-20) |
| `warmupCount` | number | 2 | Number of warmup pings (0-5) |
| `topCount` | number | 2 | Number of top results to return (1-10) |
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

### Constants

```typescript
import {
  NOZOMI_ENDPOINTS,      // Hardcoded fallback endpoints
  NOZOMI_AUTO_ENDPOINT,  // Auto-routed endpoint URL
  NOZOMI_ENDPOINTS_URL   // Default endpoints JSON URL
} from 'nozomi-sdk';
```

## Features

- **Zero dependencies** - works in Node.js and browsers
- **Never throws** - always returns valid results with fallbacks
- **Region deduplication** - returns only the fastest endpoint per region
- **Warmup pings** - accounts for TLS/TCP connection setup
- **Remote config** - fetches latest endpoints from GitHub with fallback
- **Fully typed** - complete TypeScript definitions

## License

MIT
