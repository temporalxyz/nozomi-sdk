# Nozomi SDK Examples

This directory contains runnable examples demonstrating the Nozomi SDK features.

## Prerequisites

```bash
# Install dependencies
npm install

# For transaction examples, install Solana Web3.js
npm install @solana/web3.js
```

## Examples

### 01. Basic Usage
Find the fastest endpoints with detailed timing information.

```bash
npx tsx example/01-basic-usage.ts
DEBUG=1 npx tsx example/01-basic-usage.ts  # With debug output
```

### 02. Find Single Fastest
Find just the single fastest endpoint.

```bash
npx tsx example/02-find-single-fastest.ts
```

### 03. Using NozomiClient
Use the NozomiClient class for easier API key management.

```bash
npx tsx example/03-using-nozomi-client.ts --api-key YOUR_API_KEY
# or
NOZOMI_API_KEY=xxx npx tsx example/03-using-nozomi-client.ts
```

### 04. Send Transaction
Send a Solana transaction using sendTransactionV2 (sends to all endpoints in parallel).

```bash
# With CLI args
npx tsx example/04-send-transaction.ts \
  --api-key YOUR_API_KEY \
  --private-key '[1,2,3,...]' \
  --recipient ADDRESS \
  --amount 1000

# With env vars
NOZOMI_API_KEY=xxx \
SOLANA_PRIVATE_KEY='[...]' \
npx tsx example/04-send-transaction.ts

# With debug output
DEBUG=1 NOZOMI_API_KEY=xxx SOLANA_PRIVATE_KEY='[...]' \
npx tsx example/04-send-transaction.ts
```

### 05. Keep-Warm
Demonstrate automatic connection keep-warm functionality.

```bash
npx tsx example/05-keep-warm.ts --api-key YOUR_API_KEY
# or
NOZOMI_API_KEY=xxx npx tsx example/05-keep-warm.ts
```

## Environment Variables

All examples support these environment variables:

- `NOZOMI_API_KEY` - Your Nozomi API key
- `SOLANA_PRIVATE_KEY` - JSON array of wallet secret key bytes (for transaction examples)
- `DEBUG` - Set to `1` or `true` for debug logging

## Getting Your Private Key

To get your Solana private key as a JSON array:

```javascript
// In Node.js or browser console
const wallet = /* your Keypair */;
console.log(JSON.stringify(Array.from(wallet.secretKey)));
```

Or from Phantom wallet's exported private key:
```javascript
import bs58 from 'bs58';
const secretKey = bs58.decode('YOUR_BASE58_PRIVATE_KEY');
console.log(JSON.stringify(Array.from(secretKey)));
```
