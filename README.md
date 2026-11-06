# nozomi-sdk

Clients for sending Solana transactions through Nozomi, one directory per
language. New SDKs implement [SPEC.md](SPEC.md):
- automatic discovery of the fastest endpoint
- warm, kept-alive connections
- binary `sendBatch` for every send
- concurrent sends merged with no added latency
- zero allocations per send

| Language | Directory | Install | Spec |
|---|---|---|---|
| Go | [`go/`](go) | `go get github.com/temporalxyz/nozomi-sdk/go` | yes |
| TypeScript | [`ts/`](ts) | `npm install @temporalxyz/nozomi-sdk` | predates it |

[`endpoints.json`](endpoints.json) lists every Nozomi endpoint by region. It
stays at the repo root: released clients download it from this path.

To add a language, see [SPEC.md §6](SPEC.md#6-adding-a-language).
