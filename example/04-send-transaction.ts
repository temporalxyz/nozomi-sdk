#!/usr/bin/env node
/**
 * Example 4: Send transaction with NozomiClient.sendTransactionV2
 *
 * Requires @solana/web3.js:
 *   npm install @solana/web3.js
 *
 * Usage:
 *   npx tsx example/04-send-transaction.ts \
 *     --api-key YOUR_API_KEY \
 *     --private-key '[1,2,3,...]' \
 *     --recipient ADDRESS \
 *     --amount 1000
 *
 *   Or with env vars:
 *   NOZOMI_API_KEY=xxx SOLANA_PRIVATE_KEY='[...]' npx tsx example/04-send-transaction.ts
 */
import { NozomiClient } from '../src/index';

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log('[DEBUG]', new Date().toISOString(), ...args);
};

function parseArgs() {
  const args = process.argv.slice(2);
  let apiKey = process.env.NOZOMI_API_KEY;
  let privateKey = process.env.SOLANA_PRIVATE_KEY;
  let recipient = '11111111111111111111111111111111'; // Default burn address
  let amount = '1000'; // Default 1000 lamports

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-key' && args[i + 1]) {
      apiKey = args[i + 1];
      i++;
    } else if (args[i] === '--private-key' && args[i + 1]) {
      privateKey = args[i + 1];
      i++;
    } else if (args[i] === '--recipient' && args[i + 1]) {
      recipient = args[i + 1];
      i++;
    } else if (args[i] === '--amount' && args[i + 1]) {
      amount = args[i + 1];
      i++;
    }
  }

  if (!apiKey || !privateKey) {
    console.error('Error: API key and private key required');
    console.error('Usage: npx tsx example/04-send-transaction.ts --api-key YOUR_API_KEY --private-key "[1,2,3,...]"');
    console.error('   or: NOZOMI_API_KEY=xxx SOLANA_PRIVATE_KEY="[...]" npx tsx example/04-send-transaction.ts');
    process.exit(1);
  }

  return { apiKey, privateKey, recipient, amount: parseInt(amount) };
}

async function main() {
  const { apiKey, privateKey, recipient, amount } = parseArgs();

  debug('Starting sendWithNozomiClient');
  const {
    Connection,
    Keypair,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
    PublicKey
  } = await import('@solana/web3.js');

  const client = new NozomiClient(apiKey);

  // Standard RPC for fetching blockhash
  const rpcUrl = 'https://api.mainnet-beta.solana.com';
  debug('Creating standard RPC connection to:', rpcUrl);
  const rpcConnection = new Connection(rpcUrl, 'confirmed');

  // Load keypair
  debug('Loading keypair from private key');
  const secretKey = Uint8Array.from(JSON.parse(privateKey));
  const payer = Keypair.fromSecretKey(secretKey);
  debug('Payer public key:', payer.publicKey.toBase58());

  // Build transfer transaction
  const recipientPubkey = new PublicKey(recipient);
  debug('Building transaction:', { recipient, amount });

  // Get recent blockhash
  console.log('Fetching recent blockhash...');
  const { blockhash } = await rpcConnection.getLatestBlockhash();
  debug('Blockhash:', blockhash);

  // Build versioned transaction
  const instructions = [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipientPubkey,
      lamports: amount
    })
  ];

  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([payer]);
  debug('Transaction signed');

  // Send via NozomiClient.sendTransactionV2
  console.log('Sending transaction to all fastest endpoints in parallel...');
  const sendStart = performance.now();

  try {
    const signature = await client.sendTransactionV2(transaction);
    debug('Transaction sent in', (performance.now() - sendStart).toFixed(2), 'ms');

    console.log(`\nTransaction sent! Signature: ${signature}`);
    console.log(`View on Solscan: https://solscan.io/tx/${signature}`);

    // Confirm
    console.log('\nWaiting for confirmation...');
    const confirmation = await rpcConnection.confirmTransaction(signature, 'confirmed');

    if (confirmation.value.err) {
      debug('Transaction error:', confirmation.value.err);
      console.error('Transaction failed:', confirmation.value.err);
    } else {
      debug('Transaction confirmed successfully');
      console.log('Transaction confirmed!');
    }
  } catch (err) {
    console.error('Failed to send transaction:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    client.destroy();
  }
}

main().catch(console.error);
